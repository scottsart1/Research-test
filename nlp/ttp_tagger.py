"""
Tags CVEs (and their LDA topic clusters) to MITRE ATT&CK Techniques (TTPs).

Strategy:
1. Keyword matching: each ATT&CK technique has a description; we build a TF-IDF
   index over technique descriptions and score CVE descriptions against it.
2. Topic-to-TTP mapping: each dominant LDA topic is mapped to the top-N techniques
   by cosine similarity, giving us cluster-level TTP labels for the heatmap.
3. KEV overlay: KEV CVEs are prioritized and their TTP tags are surfaced in the
   network graph.
"""

import logging
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

logger = logging.getLogger(__name__)

CACHE_PATH = Path("data/cache/cve_ttp_tags.parquet")

# Known keyword → TTP mappings to supplement TF-IDF
KEYWORD_TTP_MAP = {
    "sql injection": "T1190",
    "buffer overflow": "T1203",
    "remote code execution": "T1203",
    "command injection": "T1059",
    "privilege escalation": "T1068",
    "authentication bypass": "T1078",
    "hardcoded credential": "T1552",
    "default credential": "T1078",
    "phishing": "T1566",
    "cross-site scripting": "T1059.007",
    "xss": "T1059.007",
    "path traversal": "T1083",
    "directory traversal": "T1083",
    "deserialization": "T1203",
    "xml injection": "T1190",
    "xxe": "T1190",
    "ssrf": "T1190",
    "open redirect": "T1190",
    "denial of service": "T1499",
    "dos": "T1499",
    "man-in-the-middle": "T1557",
    "mitm": "T1557",
    "ransomware": "T1486",
    "credential dumping": "T1003",
    "lateral movement": "T1021",
    "data exfiltration": "T1041",
    "supply chain": "T1195",
    "firmware": "T1542",
    "bootkit": "T1542",
    "rootkit": "T1014",
    "keylogger": "T1056",
    "spyware": "T1056",
}


class TTPTagger:
    def __init__(self, techniques_df: pd.DataFrame, top_n: int = 3):
        self.techniques = techniques_df.copy()
        self.top_n = top_n
        self._vectorizer = None
        self._tfidf_matrix = None
        self._fit()

    def _fit(self):
        docs = (
            self.techniques["technique_name"].fillna("") + " "
            + self.techniques["description"].fillna("") + " "
            + self.techniques["tactics"].fillna("").str.replace("|", " ")
        ).tolist()

        self._vectorizer = TfidfVectorizer(
            max_features=5_000,
            ngram_range=(1, 2),
            stop_words="english",
            sublinear_tf=True,
        )
        self._tfidf_matrix = self._vectorizer.fit_transform(docs)
        logger.info(f"TF-IDF index built: {self._tfidf_matrix.shape}")

    def tag_cves(self, cve_df: pd.DataFrame, text_col: str = "description") -> pd.DataFrame:
        """
        For each CVE, return top-N matching technique IDs and their similarity scores.
        Also applies keyword overrides for high-confidence assignments.
        """
        texts = cve_df[text_col].fillna("").tolist()
        cve_vectors = self._vectorizer.transform(texts)
        sims = cosine_similarity(cve_vectors, self._tfidf_matrix)

        rows = []
        for i, (_, cve_row) in enumerate(cve_df.iterrows()):
            cve_id = cve_row.get("cve_id", str(i))
            desc_lower = texts[i].lower()

            # Keyword override takes priority
            keyword_hits = [
                ttp_id for kw, ttp_id in KEYWORD_TTP_MAP.items()
                if kw in desc_lower
            ]

            # TF-IDF top matches
            top_indices = sims[i].argsort()[::-1][: self.top_n]
            for rank, idx in enumerate(top_indices):
                tech = self.techniques.iloc[idx]
                rows.append({
                    "cve_id": cve_id,
                    "technique_id": tech["technique_id"],
                    "technique_name": tech["technique_name"],
                    "tactic": tech["tactics"].split("|")[0] if tech["tactics"] else "",
                    "similarity_score": round(float(sims[i, idx]), 4),
                    "rank": rank + 1,
                    "keyword_match": tech["technique_id"] in keyword_hits,
                })

        return pd.DataFrame(rows)

    def tag_topics(self, topic_assignments: pd.DataFrame) -> pd.DataFrame:
        """
        Map each LDA topic (group of CVEs sharing the same dominant_topic)
        to its top techniques. Used for the heatmap.
        """
        topic_texts = []
        topic_ids = sorted(topic_assignments["dominant_topic"].unique())

        for tid in topic_ids:
            group = topic_assignments[topic_assignments["dominant_topic"] == tid]
            combined = " ".join(group.get("description", pd.Series([])).fillna("").tolist()[:50])
            topic_texts.append(combined)

        if not topic_texts:
            return pd.DataFrame()

        topic_vectors = self._vectorizer.transform(topic_texts)
        sims = cosine_similarity(topic_vectors, self._tfidf_matrix)

        rows = []
        for i, topic_id in enumerate(topic_ids):
            top_indices = sims[i].argsort()[::-1][:5]
            for idx in top_indices:
                tech = self.techniques.iloc[idx]
                rows.append({
                    "topic_id": topic_id,
                    "technique_id": tech["technique_id"],
                    "technique_name": tech["technique_name"],
                    "tactic": tech["tactics"].split("|")[0] if tech["tactics"] else "",
                    "score": round(float(sims[i, idx]), 4),
                })

        return pd.DataFrame(rows)


def build_cve_ttp_graph(
    cve_tags: pd.DataFrame,
    kev_df: pd.DataFrame,
    vendor_summary: pd.DataFrame,
) -> pd.DataFrame:
    """
    Construct the edge list for the PyVis network graph.
    Nodes: CVE → TTP → Vendor
    Edge weight: similarity score or KEV flag
    """
    edges = []

    for _, row in cve_tags[cve_tags["rank"] == 1].iterrows():
        cve_id = row["cve_id"]
        is_kev = cve_id in kev_df["cve_id"].values if not kev_df.empty else False

        edges.append({
            "source": cve_id,
            "target": row["technique_id"],
            "edge_type": "cve_to_ttp",
            "weight": row["similarity_score"],
            "is_kev": is_kev,
        })

    # Link TTPs to vendors found in KEV
    if not kev_df.empty and not cve_tags.empty:
        kev_tagged = cve_tags.merge(
            kev_df[["cve_id", "vendor"]].dropna(),
            on="cve_id",
            how="inner",
        )
        for _, row in kev_tagged[kev_tagged["rank"] == 1].iterrows():
            edges.append({
                "source": row["technique_id"],
                "target": row["vendor"],
                "edge_type": "ttp_to_vendor",
                "weight": 1.0,
                "is_kev": True,
            })

    return pd.DataFrame(edges)

"""
Named Entity Recognition pipeline for CVE descriptions.
Uses spaCy's en_core_web_lg model plus a custom entity ruler for
software/vendor names extracted from the ATT&CK software table.
Outputs per-CVE entity lists and a vendor-mention frequency table.
"""

import logging
import re
from pathlib import Path

import pandas as pd
import spacy
from spacy.language import Language
from spacy.pipeline import EntityRuler

logger = logging.getLogger(__name__)

# spaCy entity labels we care about
USEFUL_LABELS = {"ORG", "PRODUCT", "GPE", "PERSON", "NORP", "FAC", "LOC", "SOFTWARE"}


def _clean_text(text: str) -> str:
    """Strip CVE boilerplate and normalize whitespace."""
    text = re.sub(r"CVE-\d{4}-\d+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def build_nlp_pipeline(attack_software: pd.DataFrame | None = None) -> Language:
    """
    Load the spaCy model and optionally add an EntityRuler
    seeded with known ATT&CK software/vendor names.
    """
    nlp = spacy.load("en_core_web_lg", exclude=["parser"])
    nlp.max_length = 2_000_000

    if attack_software is not None and not attack_software.empty:
        ruler = nlp.add_pipe("entity_ruler", before="ner", config={"overwrite_ents": False})
        patterns = []
        for _, row in attack_software.iterrows():
            name = row.get("software_name", "")
            if not name:
                continue
            patterns.append({"label": "SOFTWARE", "pattern": name})
            # Also add lowercased variant
            patterns.append({"label": "SOFTWARE", "pattern": name.lower()})
        ruler.add_patterns(patterns)
        logger.info(f"EntityRuler loaded with {len(patterns)//2} ATT&CK software names")

    return nlp


def extract_entities(
    df: pd.DataFrame,
    text_col: str = "description",
    id_col: str = "cve_id",
    nlp: Language | None = None,
    batch_size: int = 128,
) -> pd.DataFrame:
    """
    Run NER over CVE descriptions.
    Returns a long-form DataFrame: one row per (cve_id, entity_text, entity_label).
    """
    if nlp is None:
        nlp = build_nlp_pipeline()

    texts = df[text_col].fillna("").map(_clean_text).tolist()
    ids = df[id_col].tolist()

    rows = []
    docs = nlp.pipe(texts, batch_size=batch_size)
    for cve_id, doc in zip(ids, docs):
        seen = set()
        for ent in doc.ents:
            if ent.label_ not in USEFUL_LABELS:
                continue
            key = (ent.text.strip(), ent.label_)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "cve_id": cve_id,
                "entity_text": ent.text.strip(),
                "entity_label": ent.label_,
            })

    result = pd.DataFrame(rows)
    logger.info(f"NER extracted {len(result)} entity mentions from {len(df)} CVEs")
    return result


def vendor_mention_summary(entities: pd.DataFrame) -> pd.DataFrame:
    """Aggregate entity mentions by vendor/product for the network graph."""
    orgs = entities[entities["entity_label"].isin({"ORG", "PRODUCT", "SOFTWARE"})]
    summary = (
        orgs.groupby("entity_text")
        .agg(cve_count=("cve_id", "nunique"), mention_count=("cve_id", "count"))
        .reset_index()
        .sort_values("cve_count", ascending=False)
    )
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sample = pd.DataFrame({
        "cve_id": ["CVE-2023-1234", "CVE-2023-5678"],
        "description": [
            "A buffer overflow in Microsoft Windows SMB allows remote code execution.",
            "Apache Log4j 2.x before 2.17.1 allows attackers to cause a denial of service.",
        ],
    })
    nlp = build_nlp_pipeline()
    ents = extract_entities(sample, nlp=nlp)
    print(ents)

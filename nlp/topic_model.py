"""
LDA topic modeling over CVE descriptions.
Produces:
  - A fitted LdaModel (serialized to disk)
  - Per-CVE dominant topic assignments
  - Per-topic keyword summaries
  - t-SNE coordinates for the dashboard scatter plot
"""

import logging
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from gensim import corpora
from gensim.models import LdaModel
from gensim.utils import simple_preprocess
from sklearn.manifold import TSNE

logger = logging.getLogger(__name__)

MODEL_DIR = Path("data/models")
N_TOPICS = 12  # empirically tuned for CVE domain

# Domain-specific stopwords on top of gensim defaults
CVE_STOPWORDS = {
    "vulnerability", "cve", "allow", "allows", "attacker", "attackers",
    "via", "use", "may", "could", "would", "also", "version", "versions",
    "affect", "affects", "affected", "cause", "caused", "result", "exist",
    "exist", "before", "prior", "issue", "product", "software", "code",
    "remote", "local", "user", "users", "system", "systems", "file", "files",
    "application", "applications", "server", "servers",
}


def _tokenize(text: str) -> list[str]:
    tokens = simple_preprocess(text, deacc=True, min_len=3)
    return [t for t in tokens if t not in CVE_STOPWORDS]


def build_corpus(df: pd.DataFrame, text_col: str = "description") -> tuple:
    """Tokenize descriptions and build gensim dictionary + corpus."""
    texts = df[text_col].fillna("").map(_tokenize).tolist()
    dictionary = corpora.Dictionary(texts)
    # Filter extremes: ignore tokens in <5 docs or >80% of docs
    dictionary.filter_extremes(no_below=5, no_above=0.80, keep_n=8_000)
    corpus = [dictionary.doc2bow(t) for t in texts]
    return corpus, dictionary, texts


def train(
    df: pd.DataFrame,
    n_topics: int = N_TOPICS,
    passes: int = 10,
    random_state: int = 42,
    use_cache: bool = True,
) -> tuple[LdaModel, corpora.Dictionary, pd.DataFrame]:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIR / f"lda_{n_topics}topics"
    dict_path = MODEL_DIR / "lda_dictionary.pkl"
    assignments_path = MODEL_DIR / "topic_assignments.parquet"

    if use_cache and model_path.exists() and dict_path.exists():
        logger.info("Loading cached LDA model")
        lda = LdaModel.load(str(model_path))
        with open(dict_path, "rb") as f:
            dictionary = pickle.load(f)
        assignments = pd.read_parquet(assignments_path)
        return lda, dictionary, assignments

    corpus, dictionary, _ = build_corpus(df)

    logger.info(f"Training LDA: {n_topics} topics, {len(df)} documents")
    lda = LdaModel(
        corpus=corpus,
        id2word=dictionary,
        num_topics=n_topics,
        passes=passes,
        random_state=random_state,
        alpha="auto",
        eta="auto",
        per_word_topics=False,
    )

    lda.save(str(model_path))
    with open(dict_path, "wb") as f:
        pickle.dump(dictionary, f)

    assignments = _assign_topics(df, lda, corpus)
    assignments.to_parquet(assignments_path, index=False)

    logger.info("LDA training complete")
    return lda, dictionary, assignments


def _assign_topics(
    df: pd.DataFrame,
    lda: LdaModel,
    corpus: list,
) -> pd.DataFrame:
    rows = []
    for i, (_, row) in enumerate(df.iterrows()):
        topic_dist = lda.get_document_topics(corpus[i], minimum_probability=0.0)
        topic_probs = sorted(topic_dist, key=lambda x: x[1], reverse=True)
        dominant_topic = topic_probs[0][0] if topic_probs else -1
        dominant_prob = topic_probs[0][1] if topic_probs else 0.0
        rows.append({
            "cve_id": row.get("cve_id", str(i)),
            "dominant_topic": dominant_topic,
            "topic_probability": round(dominant_prob, 4),
        })

    return pd.DataFrame(rows)


def get_topic_labels(lda: LdaModel, n_words: int = 5) -> dict[int, str]:
    """Build human-readable labels from top keywords per topic."""
    labels = {}
    for topic_id in range(lda.num_topics):
        words = [w for w, _ in lda.show_topic(topic_id, topn=n_words)]
        labels[topic_id] = " / ".join(words[:3])
    return labels


def compute_tsne(
    df: pd.DataFrame,
    lda: LdaModel,
    dictionary: corpora.Dictionary,
) -> pd.DataFrame:
    """
    Project document-topic distributions into 2D via t-SNE.
    Returns df with columns: cve_id, tsne_x, tsne_y, dominant_topic.
    """
    corpus, _, _ = build_corpus(df)
    n_topics = lda.num_topics

    doc_vectors = np.zeros((len(df), n_topics))
    for i, bow in enumerate(corpus):
        topic_dist = lda.get_document_topics(bow, minimum_probability=0.0)
        for topic_id, prob in topic_dist:
            doc_vectors[i, topic_id] = prob

    perplexity = min(30, len(df) - 1)
    tsne = TSNE(
        n_components=2,
        perplexity=perplexity,
        n_iter=500,
        random_state=42,
        init="pca",
    )
    coords = tsne.fit_transform(doc_vectors)

    result = df[["cve_id"]].copy()
    result["tsne_x"] = coords[:, 0]
    result["tsne_y"] = coords[:, 1]
    result["dominant_topic"] = doc_vectors.argmax(axis=1)
    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sample_df = pd.DataFrame({
        "cve_id": [f"CVE-2023-{i:04d}" for i in range(50)],
        "description": [
            "Buffer overflow in network stack allows remote code execution via crafted packet." * 2,
            "SQL injection in web application enables authentication bypass and data exfiltration." * 2,
            "Improper input validation in firmware allows privilege escalation on IoT devices." * 2,
            "Use-after-free in browser engine enables arbitrary code execution when visiting a page." * 2,
            "Hardcoded credentials in router firmware allow unauthorized admin access." * 2,
        ] * 10,
    })
    lda, dictionary, assignments = train(sample_df, n_topics=5, passes=3, use_cache=False)
    labels = get_topic_labels(lda)
    print("Topic labels:", labels)
    print(assignments.head())

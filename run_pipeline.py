"""
MITRE Supply Threat Watch — Pipeline Orchestrator
==================================================
Runs both data pipelines end-to-end and writes results to Snowflake (or local parquet).

Usage:
  python run_pipeline.py                    # full run
  python run_pipeline.py --mode ingestion   # ingestion only
  python run_pipeline.py --mode nlp         # NLP pipeline only
  python run_pipeline.py --mode forecast    # forecasting pipeline only
  python run_pipeline.py --refresh-cache    # wipe local cache and re-fetch
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("pipeline")


def run_ingestion(use_cache: bool) -> dict:
    from ingestion import mitre_attack, cisa_kev, nvd_cve, census_retail, fred_indices
    from db.snowflake_client import write_table

    logger.info("=== Ingestion Pipeline ===")
    results = {}

    t0 = time.time()
    attack_tables = mitre_attack.run(use_cache=use_cache)
    results["mitre"] = attack_tables
    for name, df in attack_tables.items():
        write_table(df, f"mitre_{name}")
    logger.info(f"ATT&CK ingestion done in {time.time()-t0:.1f}s")

    t0 = time.time()
    kev_df = cisa_kev.run(use_cache=use_cache)
    results["kev"] = kev_df
    write_table(kev_df, "cisa_kev")
    logger.info(f"CISA KEV ingestion done in {time.time()-t0:.1f}s")

    t0 = time.time()
    cve_df = nvd_cve.fetch_cves(days_back=730, max_results=8000, use_cache=use_cache)
    results["cve"] = cve_df
    write_table(cve_df, "nvd_cves")
    logger.info(f"NVD CVE ingestion done in {time.time()-t0:.1f}s")

    t0 = time.time()
    retail_df = census_retail.run(use_cache=use_cache)
    results["retail"] = retail_df
    write_table(retail_df, "census_retail")
    logger.info(f"Census retail ingestion done in {time.time()-t0:.1f}s")

    t0 = time.time()
    fred_df = fred_indices.run(use_cache=use_cache)
    results["fred"] = fred_df
    write_table(fred_df, "fred_series")
    logger.info(f"FRED ingestion done in {time.time()-t0:.1f}s")

    return results


def run_nlp_pipeline(ingestion_results: dict) -> dict:
    import pickle

    from nlp.ner_pipeline import build_nlp_pipeline, extract_entities, vendor_mention_summary
    from nlp.topic_model import compute_tsne, get_topic_labels, train
    from nlp.ttp_tagger import TTPTagger, build_cve_ttp_graph
    from db.snowflake_client import write_table

    logger.info("=== NLP Pipeline ===")

    cve_df = ingestion_results.get("cve")
    kev_df = ingestion_results.get("kev")
    attack_tables = ingestion_results.get("mitre", {})
    techniques = attack_tables.get("techniques")
    software = attack_tables.get("software")

    if cve_df is None or cve_df.empty:
        logger.warning("No CVE data — skipping NLP pipeline")
        return {}

    # NER
    logger.info("Running NER over CVE descriptions...")
    nlp = build_nlp_pipeline(attack_software=software)
    entities = extract_entities(cve_df, nlp=nlp)
    vendor_summary = vendor_mention_summary(entities)
    write_table(entities, "cve_entities")

    # LDA topic modeling
    logger.info("Training LDA topic model...")
    lda, dictionary, topic_assignments = train(cve_df, n_topics=12, passes=15)
    write_table(topic_assignments, "cve_topics")

    topic_labels = get_topic_labels(lda)
    model_dir = Path("data/models")
    model_dir.mkdir(parents=True, exist_ok=True)
    with open(model_dir / "topic_labels.json", "w") as f:
        json.dump({str(k): v for k, v in topic_labels.items()}, f, indent=2)

    # t-SNE (only on a sample if large to keep it fast)
    sample_size = min(3000, len(cve_df))
    logger.info(f"Computing t-SNE on {sample_size} CVEs...")
    tsne_df = compute_tsne(cve_df.sample(sample_size, random_state=42), lda, dictionary)
    tsne_df.to_parquet(model_dir / "tsne_coords.parquet", index=False)

    # TTP tagging
    if techniques is not None and not techniques.empty:
        logger.info("Tagging CVEs to ATT&CK TTPs...")
        tagger = TTPTagger(techniques)
        cve_tags = tagger.tag_cves(cve_df)
        topic_ttp_map = tagger.tag_topics(
            topic_assignments.merge(cve_df[["cve_id", "description"]], on="cve_id", how="left")
        )
        write_table(cve_tags, "cve_ttp_tags")

        graph_edges = build_cve_ttp_graph(cve_tags, kev_df, vendor_summary)
        write_table(graph_edges, "cve_ttp_graph_edges")
    else:
        logger.warning("No techniques data — skipping TTP tagging")
        cve_tags = None
        graph_edges = None

    return {
        "entities": entities,
        "topic_assignments": topic_assignments,
        "cve_tags": cve_tags,
        "graph_edges": graph_edges,
        "topic_labels": topic_labels,
    }


def run_forecasting_pipeline(ingestion_results: dict, nlp_results: dict) -> dict:
    from forecasting.feature_engineering import build_feature_matrix, build_threat_monthly
    from forecasting.xgboost_model import RetailForecaster, run_all_categories
    from forecasting.anomaly_detector import (
        annotate_anomaly_events,
        detect_cross_pipeline_anomalies,
        detect_forecast_anomalies,
    )
    from db.snowflake_client import write_table

    logger.info("=== Forecasting Pipeline ===")

    retail_df = ingestion_results.get("retail")
    fred_df = ingestion_results.get("fred")
    cve_df = ingestion_results.get("cve")
    kev_df = ingestion_results.get("kev")

    if retail_df is None or retail_df.empty:
        logger.warning("No retail data — skipping forecasting pipeline")
        return {}

    # Build threat monthly summary
    threat_monthly = build_threat_monthly(
        cve_df if cve_df is not None else __import__("pandas").DataFrame(),
        kev_df if kev_df is not None else __import__("pandas").DataFrame(),
    )
    threat_monthly.to_parquet(Path("data/local_db/threat_monthly.parquet"), index=False)

    # Retail categories to forecast
    retail_categories = [
        "total_retail_food",
        "clothing_accessories",
        "nonstore_retailers",
        "food_services",
        "general_merchandise",
    ]

    feature_matrices = {}
    for cat in retail_categories:
        if cat not in retail_df.columns:
            continue
        try:
            fm = build_feature_matrix(retail_df, fred_df or __import__("pandas").DataFrame(), threat_monthly, cat)
            if len(fm) >= 24:
                feature_matrices[cat] = fm
        except Exception as e:
            logger.warning(f"Feature engineering failed for {cat}: {e}")

    if not feature_matrices:
        logger.warning("No feature matrices built — check data completeness")
        return {}

    logger.info(f"Training XGBoost for {len(feature_matrices)} categories...")
    models, forecast_df = run_all_categories(feature_matrices)

    # Anomaly detection on forecasts
    forecast_df = detect_forecast_anomalies(forecast_df)
    write_table(forecast_df, "retail_forecasts")

    # Cross-pipeline anomaly detection
    first_cat_df = next(iter(feature_matrices.values()))
    merged = first_cat_df.merge(
        forecast_df[forecast_df["category"] == list(feature_matrices.keys())[0]][
            ["period", "residual", "is_anomaly"]
        ],
        on="period",
        how="left",
    )
    anomaly_df = detect_cross_pipeline_anomalies(merged)
    anomaly_events = annotate_anomaly_events(anomaly_df)
    write_table(anomaly_events, "anomaly_events")

    logger.info(
        f"Anomaly detection: {anomaly_df['cross_anomaly'].sum()} anomalous months identified"
    )
    return {
        "models": models,
        "forecast_df": forecast_df,
        "anomaly_df": anomaly_df,
        "anomaly_events": anomaly_events,
    }


def main():
    parser = argparse.ArgumentParser(description="MITRE Supply Threat Watch pipeline")
    parser.add_argument(
        "--mode",
        choices=["all", "ingestion", "nlp", "forecast"],
        default="all",
        help="Which pipeline stage to run",
    )
    parser.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Ignore cached files and re-fetch all data",
    )
    args = parser.parse_args()

    use_cache = not args.refresh_cache
    Path("data/local_db").mkdir(parents=True, exist_ok=True)
    Path("data/models").mkdir(parents=True, exist_ok=True)

    wall_start = time.time()

    if args.mode in ("all", "ingestion"):
        ingestion_results = run_ingestion(use_cache)
    else:
        # Load from cache for downstream stages
        from ingestion import mitre_attack, cisa_kev, nvd_cve, census_retail, fred_indices
        attack_tables = mitre_attack.run(use_cache=True)
        ingestion_results = {
            "mitre": attack_tables,
            "kev": cisa_kev.run(use_cache=True),
            "cve": nvd_cve.fetch_cves(use_cache=True),
            "retail": census_retail.run(use_cache=True),
            "fred": fred_indices.run(use_cache=True),
        }

    nlp_results = {}
    if args.mode in ("all", "nlp"):
        nlp_results = run_nlp_pipeline(ingestion_results)

    if args.mode in ("all", "forecast"):
        run_forecasting_pipeline(ingestion_results, nlp_results)

    elapsed = time.time() - wall_start
    logger.info(f"Pipeline complete in {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()

"""
Isolation Forest anomaly detection for identifying months where
threat-intel spikes correlate with supply-chain disruptions.

Two detection modes:
  1. Univariate: flag months with anomalous retail values vs forecast
  2. Multivariate: flag months where threat + supply features cluster unusually
"""

import logging
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

logger = logging.getLogger(__name__)


# Features used for multivariate anomaly detection
MULTIVARIATE_FEATURES = [
    "cve_count",
    "critical_count",
    "kev_count",
    "ransomware_kev",
    "avg_cvss",
    "global_supply_chain_pressure_index",
    "inventory_sales_ratio",
    "residual",  # forecast error — large errors signal structural breaks
]


def detect_forecast_anomalies(
    forecast_df: pd.DataFrame,
    contamination: float = 0.08,
) -> pd.DataFrame:
    """
    Flag months where the forecast residual is unusually large.
    Operates per-category on the residual column.
    """
    results = []

    for category, grp in forecast_df.groupby("category"):
        grp = grp.dropna(subset=["residual"]).sort_values("period").copy()
        if len(grp) < 10:
            results.append(grp)
            continue

        X = grp[["residual"]].values
        scaler = RobustScaler()
        X_scaled = scaler.fit_transform(X)

        iso = IsolationForest(
            n_estimators=200,
            contamination=contamination,
            random_state=42,
        )
        grp["anomaly_score"] = iso.fit_predict(X_scaled)
        grp["is_anomaly"] = grp["anomaly_score"] == -1

        results.append(grp)

    return pd.concat(results, ignore_index=True)


def detect_cross_pipeline_anomalies(
    merged_df: pd.DataFrame,
    contamination: float = 0.06,
) -> pd.DataFrame:
    """
    Multivariate Isolation Forest across both threat-intel and supply-chain features.
    The key question: which months are jointly anomalous in BOTH pipelines?
    Returns a dataframe with anomaly labels and scores for the timeline chart.
    """
    df = merged_df.copy()
    feature_cols = [c for c in MULTIVARIATE_FEATURES if c in df.columns]

    if len(feature_cols) < 3:
        logger.warning("Not enough multivariate features for anomaly detection")
        df["cross_anomaly"] = False
        df["cross_anomaly_score"] = np.nan
        return df

    X = df[feature_cols].copy()
    X = X.fillna(X.median())

    scaler = RobustScaler()
    X_scaled = scaler.fit_transform(X)

    iso = IsolationForest(
        n_estimators=300,
        contamination=contamination,
        max_features=min(len(feature_cols), 6),
        random_state=42,
    )
    iso.fit(X_scaled)

    df["cross_anomaly_score"] = -iso.score_samples(X_scaled)  # higher = more anomalous
    df["cross_anomaly"] = iso.predict(X_scaled) == -1

    n_anomalies = df["cross_anomaly"].sum()
    logger.info(f"Cross-pipeline anomalies detected: {n_anomalies} months")
    return df


def annotate_anomaly_events(anomaly_df: pd.DataFrame) -> pd.DataFrame:
    """
    For each anomalous month, generate a human-readable event label
    based on which features drove the anomaly.
    """
    rows = []
    for _, row in anomaly_df[anomaly_df.get("cross_anomaly", False)].iterrows():
        drivers = []

        if row.get("cve_count", 0) > anomaly_df["cve_count"].quantile(0.80):
            drivers.append("CVE surge")
        if row.get("kev_count", 0) > anomaly_df["kev_count"].quantile(0.80):
            drivers.append("KEV spike")
        if row.get("ransomware_kev", 0) > 2:
            drivers.append("ransomware activity")
        if (
            "global_supply_chain_pressure_index" in row.index
            and row.get("global_supply_chain_pressure_index", 0)
            > anomaly_df["global_supply_chain_pressure_index"].quantile(0.80)
        ):
            drivers.append("supply chain pressure")
        if abs(row.get("residual", 0)) > abs(anomaly_df["residual"]).quantile(0.85):
            drivers.append("forecast miss")

        label = " + ".join(drivers) if drivers else "anomalous period"
        rows.append({
            "period": row.get("period"),
            "year_month": row.get("year_month"),
            "anomaly_label": label,
            "cross_anomaly_score": row.get("cross_anomaly_score", np.nan),
        })

    return pd.DataFrame(rows)

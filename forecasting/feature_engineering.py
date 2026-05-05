"""
Feature engineering for the retail time-series forecasting model.
Merges retail sales data with FRED supply-chain indices and
threat-intel monthly summaries (CVE counts, KEV counts, severity scores).
"""

import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def add_time_features(df: pd.DataFrame, date_col: str = "period") -> pd.DataFrame:
    df = df.copy()
    dt = pd.to_datetime(df[date_col])
    df["month"] = dt.dt.month
    df["quarter"] = dt.dt.quarter
    df["year"] = dt.dt.year
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)
    # Holiday season flag (Nov, Dec)
    df["is_holiday_season"] = df["month"].isin([11, 12]).astype(int)
    # Back-to-school flag (July, Aug)
    df["is_bts_season"] = df["month"].isin([7, 8]).astype(int)
    return df


def add_lag_features(
    df: pd.DataFrame,
    target_col: str,
    lags: list[int] = [1, 2, 3, 6, 12],
) -> pd.DataFrame:
    df = df.copy().sort_values("period")
    for lag in lags:
        df[f"{target_col}_lag{lag}"] = df[target_col].shift(lag)
    return df


def add_rolling_features(
    df: pd.DataFrame,
    target_col: str,
    windows: list[int] = [3, 6, 12],
) -> pd.DataFrame:
    df = df.copy().sort_values("period")
    for w in windows:
        df[f"{target_col}_roll{w}_mean"] = df[target_col].shift(1).rolling(w).mean()
        df[f"{target_col}_roll{w}_std"] = df[target_col].shift(1).rolling(w).std()
    return df


def build_threat_monthly(cve_df: pd.DataFrame, kev_df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate threat-intel data to monthly granularity.
    Features:
      - cve_count: new CVEs published per month
      - critical_count: CRITICAL severity CVEs
      - kev_count: newly added KEV entries
      - ransomware_kev: KEVs flagged as ransomware-associated
      - avg_cvss: mean CVSS score
      - threat_spike: binary flag for months > 1.5 std above rolling mean
    """
    # Monthly CVE counts
    cve_monthly = (
        cve_df.groupby("year_month")
        .agg(
            cve_count=("cve_id", "count"),
            critical_count=("cvss_severity", lambda x: (x == "CRITICAL").sum()),
            high_count=("cvss_severity", lambda x: (x == "HIGH").sum()),
            avg_cvss=("cvss_base_score", "mean"),
        )
        .reset_index()
    )

    # Monthly KEV counts
    kev_monthly = (
        kev_df.groupby("year_month")
        .agg(
            kev_count=("cve_id", "count"),
            ransomware_kev=("is_ransomware", "sum"),
        )
        .reset_index()
    )

    merged = cve_monthly.merge(kev_monthly, on="year_month", how="left")
    merged["kev_count"] = merged["kev_count"].fillna(0)
    merged["ransomware_kev"] = merged["ransomware_kev"].fillna(0)

    # Threat spike: rolling z-score on cve_count
    roll_mean = merged["cve_count"].rolling(6, min_periods=3).mean()
    roll_std = merged["cve_count"].rolling(6, min_periods=3).std().clip(lower=1)
    merged["cve_zscore"] = (merged["cve_count"] - roll_mean) / roll_std
    merged["threat_spike"] = (merged["cve_zscore"] > 1.5).astype(int)

    # Lag the threat features by 1-3 months (threats precede supply disruption)
    for lag in [1, 2, 3]:
        merged[f"cve_count_lag{lag}"] = merged["cve_count"].shift(lag)
        merged[f"kev_count_lag{lag}"] = merged["kev_count"].shift(lag)
        merged[f"ransomware_kev_lag{lag}"] = merged["ransomware_kev"].shift(lag)

    return merged


def build_feature_matrix(
    retail_df: pd.DataFrame,
    fred_df: pd.DataFrame,
    threat_monthly: pd.DataFrame,
    target_category: str = "total_retail_food",
) -> pd.DataFrame:
    """
    Merge all data sources into a single feature matrix ready for XGBoost.
    """
    df = retail_df[["period", "year_month", target_category]].copy()
    df.rename(columns={target_category: "target"}, inplace=True)
    df["period"] = pd.to_datetime(df["period"])

    # Merge FRED supply-chain features
    fred_cols = ["year_month"] + [c for c in fred_df.columns if c not in ("period", "year_month")]
    df = df.merge(fred_df[fred_cols], on="year_month", how="left")

    # Merge threat intelligence features
    df = df.merge(threat_monthly, on="year_month", how="left")

    # Time features
    df = add_time_features(df)
    df = add_lag_features(df, "target")
    df = add_rolling_features(df, "target")

    # Supply chain pressure lags
    if "global_supply_chain_pressure_index" in df.columns:
        df = add_lag_features(df, "global_supply_chain_pressure_index", lags=[1, 2, 3])

    # Drop rows with too many NaN lag values
    df = df.dropna(subset=["target_lag12"])

    logger.info(f"Feature matrix: {df.shape[0]} rows × {df.shape[1]} columns")
    return df

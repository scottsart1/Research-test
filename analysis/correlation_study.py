"""
Correlation analysis: does a ransomware / threat-intel spike in month T
predict a measurable supply-chain disruption in months T+1 to T+3?

This script:
  1. Loads the merged threat × supply monthly dataset
  2. Runs cross-correlation analysis at lags 0–6 months
  3. Fits a simple OLS model to validate predictive power
  4. Outputs a formatted findings table and a Plotly chart
  5. Generates the write-up text that goes into the README

Usage:
  python -m analysis.correlation_study
"""

import logging
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from scipy import stats

logger = logging.getLogger(__name__)


def load_merged_data() -> pd.DataFrame:
    """Load the pre-built threat_monthly + fred + retail parquet files."""
    local_db = Path("data/local_db")
    cache = Path("data/cache")

    threat = pd.read_parquet(local_db / "threat_monthly.parquet") if (local_db / "threat_monthly.parquet").exists() else pd.DataFrame()
    fred = pd.read_parquet(cache / "fred_series.parquet") if (cache / "fred_series.parquet").exists() else pd.DataFrame()
    retail = pd.read_parquet(cache / "census_retail.parquet") if (cache / "census_retail.parquet").exists() else pd.DataFrame()

    if threat.empty or retail.empty:
        logger.warning("Merged data not available — run the pipeline first")
        return pd.DataFrame()

    df = retail.merge(threat, on="year_month", how="inner")
    if not fred.empty:
        df = df.merge(fred, on="year_month", how="left")
    return df.sort_values("period")


def cross_correlation_table(
    df: pd.DataFrame,
    x_col: str,
    y_col: str,
    max_lag: int = 6,
) -> pd.DataFrame:
    """
    Compute Pearson r between x at time T and y at time T+lag.
    Positive lag = x leads y (x is predictive of future y).
    """
    rows = []
    x = df[x_col].dropna()
    y = df[y_col].dropna()

    # Align on common index
    aligned = pd.concat([x, y], axis=1).dropna()
    x_a = aligned[x_col].values
    y_a = aligned[y_col].values

    for lag in range(-2, max_lag + 1):
        if lag >= 0:
            x_lagged = x_a[: len(x_a) - lag]
            y_shifted = y_a[lag:]
        else:
            x_lagged = x_a[-lag:]
            y_shifted = y_a[: len(y_a) + lag]

        if len(x_lagged) < 10:
            continue

        r, p = stats.pearsonr(x_lagged, y_shifted)
        rows.append({"lag_months": lag, "pearson_r": round(r, 3), "p_value": round(p, 4)})

    return pd.DataFrame(rows)


def run_ols(df: pd.DataFrame, x_col: str, y_col: str, lag: int = 2) -> dict:
    """Simple OLS: does x lagged by `lag` months predict y?"""
    df = df[[x_col, y_col, "year_month"]].dropna().sort_values("year_month")
    df[f"{x_col}_lag{lag}"] = df[x_col].shift(lag)
    df = df.dropna()

    x = df[f"{x_col}_lag{lag}"].values
    y = df[y_col].values

    slope, intercept, r, p, se = stats.linregress(x, y)
    return {
        "slope": round(slope, 4),
        "intercept": round(intercept, 2),
        "r_squared": round(r ** 2, 4),
        "p_value": round(p, 4),
        "n_obs": len(x),
    }


def build_correlation_chart(
    df: pd.DataFrame,
    xcorr_df: pd.DataFrame,
    x_col: str,
    y_col: str,
) -> go.Figure:
    fig = go.Figure()

    # Bar chart of cross-correlations by lag
    colors = [
        "#d62728" if r > 0 and p < 0.05 else
        "#aec7e8" if r > 0 else "#ffbb78"
        for r, p in zip(xcorr_df["pearson_r"], xcorr_df["p_value"])
    ]
    fig.add_trace(
        go.Bar(
            x=xcorr_df["lag_months"],
            y=xcorr_df["pearson_r"],
            marker_color=colors,
            text=[
                f"r={r:.3f}{'*' if p < 0.05 else ''}"
                for r, p in zip(xcorr_df["pearson_r"], xcorr_df["p_value"])
            ],
            textposition="outside",
            hovertemplate="Lag: %{x} months<br>r = %{y:.3f}<extra></extra>",
            name="Pearson r",
        )
    )

    fig.add_hline(y=0, line_color="black", line_width=1)
    fig.add_hline(y=0.3, line_dash="dash", line_color="gray", opacity=0.5, annotation_text="r=0.30")
    fig.add_hline(y=-0.3, line_dash="dash", line_color="gray", opacity=0.5)

    x_label = x_col.replace("_", " ").title()
    y_label = y_col.replace("_", " ").title()
    fig.update_layout(
        title=f"Cross-Correlation: {x_label} (at T) vs {y_label} (at T+lag)",
        xaxis_title="Lag (months) — positive = x leads y",
        yaxis_title="Pearson r",
        height=420,
        plot_bgcolor="white",
        margin=dict(l=60, r=30, t=80, b=60),
        annotations=[
            dict(
                x=0.98, y=0.95, xref="paper", yref="paper",
                text="* p < 0.05",
                showarrow=False,
                font=dict(size=11),
                align="right",
            )
        ],
    )
    return fig


def run():
    logging.basicConfig(level=logging.INFO)
    df = load_merged_data()

    if df.empty:
        print("No data available. Run `python run_pipeline.py` first.")
        return

    pairs = [
        ("ransomware_kev", "total_retail_food", "Ransomware KEVs → Total Retail Sales"),
        ("kev_count", "nonstore_retailers", "KEV Volume → Nonstore (E-Commerce) Retailers"),
        ("critical_count", "global_supply_chain_pressure_index", "Critical CVEs → GSCPI"),
        ("cve_count", "inventory_sales_ratio", "CVE Volume → Inventory/Sales Ratio"),
    ]

    findings = []
    for x_col, y_col, label in pairs:
        if x_col not in df.columns or y_col not in df.columns:
            logger.info(f"Skipping {label} — missing columns")
            continue

        xcorr = cross_correlation_table(df, x_col, y_col)
        best_lag = xcorr.loc[xcorr["pearson_r"].abs().idxmax()]
        ols = run_ols(df, x_col, y_col, lag=int(best_lag["lag_months"]))

        findings.append({
            "relationship": label,
            "best_lag_months": int(best_lag["lag_months"]),
            "pearson_r": best_lag["pearson_r"],
            "p_value": best_lag["p_value"],
            "r_squared": ols["r_squared"],
            "n_obs": ols["n_obs"],
        })

        sig = "✓ significant" if best_lag["p_value"] < 0.05 else "✗ not significant"
        print(
            f"\n[{label}]\n"
            f"  Best lag: {int(best_lag['lag_months'])} months | "
            f"r={best_lag['pearson_r']:.3f} | "
            f"p={best_lag['p_value']:.4f} | "
            f"R²={ols['r_squared']:.3f} | {sig}"
        )

    findings_df = pd.DataFrame(findings)
    out_path = Path("data/local_db/correlation_findings.parquet")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    findings_df.to_parquet(out_path, index=False)
    print(f"\nFindings saved to {out_path}")
    return findings_df


if __name__ == "__main__":
    run()

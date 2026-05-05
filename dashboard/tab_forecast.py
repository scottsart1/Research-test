"""
Tab 2: Supply Chain Forecasting + Anomaly Detection.
Forecast vs. actual chart, MAPE bar chart, and cross-pipeline anomaly timeline.
"""

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from dashboard.components.anomaly_timeline import build_anomaly_timeline
from dashboard.components.mape_chart import build_mape_bar
from forecasting.xgboost_model import compute_mape_by_category


def build_forecast_chart(
    forecast_df: pd.DataFrame,
    category: str,
    anomaly_df: pd.DataFrame | None = None,
) -> go.Figure:
    """Actual vs. forecast line chart with 90% prediction interval shading."""
    df = forecast_df[forecast_df["category"] == category].sort_values("period")
    if df.empty:
        return go.Figure()

    fig = go.Figure()

    # Prediction interval shading
    has_intervals = "forecast_lower" in df.columns and "forecast_upper" in df.columns
    if has_intervals:
        fig.add_trace(
            go.Scatter(
                x=pd.concat([df["period"], df["period"].iloc[::-1]]),
                y=pd.concat([df["forecast_upper"], df["forecast_lower"].iloc[::-1]]),
                fill="toself",
                fillcolor="rgba(31,119,180,0.15)",
                line=dict(color="rgba(255,255,255,0)"),
                name="90% prediction interval",
                hoverinfo="skip",
            )
        )

    # Actual values
    fig.add_trace(
        go.Scatter(
            x=df["period"],
            y=df["target"],
            mode="lines",
            name="Actual",
            line=dict(color="#2c3e50", width=2.5),
            hovertemplate="Actual: %{y:,.0f}<br>%{x|%b %Y}<extra></extra>",
        )
    )

    # Forecast
    fig.add_trace(
        go.Scatter(
            x=df["period"],
            y=df["forecast"],
            mode="lines",
            name="Forecast",
            line=dict(color="#1f77b4", width=2, dash="dash"),
            hovertemplate="Forecast: %{y:,.0f}<br>%{x|%b %Y}<extra></extra>",
        )
    )

    # Anomaly markers on the forecast chart
    if anomaly_df is not None:
        anom = anomaly_df.merge(df[["period"]], on="period", how="inner")
        anom_events = anom[anom.get("cross_anomaly", pd.Series(False, index=anom.index)) == True]
        if not anom_events.empty:
            matching = df[df["period"].isin(anom_events["period"])]
            fig.add_trace(
                go.Scatter(
                    x=matching["period"],
                    y=matching["target"],
                    mode="markers",
                    name="Anomaly flagged",
                    marker=dict(color="#d62728", size=12, symbol="x", line=dict(width=2)),
                    hovertemplate="⚠ Anomaly: %{x|%b %Y}<extra></extra>",
                )
            )

    category_label = category.replace("_", " ").title()
    fig.update_layout(
        title=f"Retail Forecast vs. Actual — {category_label}",
        xaxis_title="Month",
        yaxis_title="Sales (millions USD)",
        height=460,
        hovermode="x unified",
        plot_bgcolor="white",
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="right",
            x=1,
        ),
        margin=dict(l=60, r=30, t=80, b=60),
    )
    fig.update_xaxes(showgrid=True, gridcolor="#eeeeee")
    fig.update_yaxes(showgrid=True, gridcolor="#eeeeee", tickformat=",")
    return fig


def render(
    forecast_df: pd.DataFrame,
    anomaly_df: pd.DataFrame,
    threat_monthly: pd.DataFrame,
):
    st.subheader("Retail Sales Forecast")
    st.markdown(
        "XGBoost model trained on retail + FRED supply-chain indices with "
        "lagged threat-intelligence features. Shaded band = 90% prediction interval."
    )

    categories = sorted(forecast_df["category"].unique()) if not forecast_df.empty else []
    if not categories:
        st.warning("No forecast data available. Run the pipeline first (`python run_pipeline.py`).")
        return

    selected_cat = st.selectbox(
        "Retail category",
        options=categories,
        format_func=lambda x: x.replace("_", " ").title(),
    )

    fig = build_forecast_chart(forecast_df, selected_cat, anomaly_df)
    st.plotly_chart(fig, use_container_width=True)

    # MAPE table
    mape_df = compute_mape_by_category(forecast_df)
    col1, col2 = st.columns([1.5, 1])
    with col1:
        st.subheader("Forecast Accuracy by Category")
        fig_mape = build_mape_bar(mape_df)
        st.plotly_chart(fig_mape, use_container_width=True)
    with col2:
        st.subheader("MAPE Summary")
        display_df = mape_df.copy()
        display_df["category"] = display_df["category"].str.replace("_", " ").str.title()
        display_df["mape"] = display_df["mape"].map(lambda x: f"{x:.2f}%")
        st.dataframe(display_df, hide_index=True, use_container_width=True)

    st.divider()

    # Cross-pipeline anomaly timeline
    st.subheader("Cross-Pipeline Anomaly Timeline")
    st.markdown(
        "Months where Isolation Forest detected joint anomalies across threat-intel "
        "(CVE/KEV spikes) and supply-chain (retail + FRED) signals are marked in red."
    )
    if not anomaly_df.empty and not threat_monthly.empty:
        fig_timeline = build_anomaly_timeline(anomaly_df, threat_monthly)
        st.plotly_chart(fig_timeline, use_container_width=True)

    # Anomaly event table
    if not anomaly_df.empty:
        anom_events = anomaly_df[anomaly_df.get("cross_anomaly", False) == True]
        if not anom_events.empty:
            st.subheader("Detected Anomalous Months")
            display_cols = ["year_month", "anomaly_label", "cross_anomaly_score"]
            display_cols = [c for c in display_cols if c in anom_events.columns]
            st.dataframe(
                anom_events[display_cols].sort_values("cross_anomaly_score", ascending=False),
                hide_index=True,
                use_container_width=True,
            )

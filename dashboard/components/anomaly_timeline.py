"""
Anomaly event timeline chart.
Shows monthly anomaly scores as a line, with event markers where Isolation Forest
flagged joint threat + supply-chain anomalies.
"""

import pandas as pd
import plotly.graph_objects as go


def build_anomaly_timeline(
    anomaly_df: pd.DataFrame,
    threat_monthly: pd.DataFrame,
) -> go.Figure:
    """
    Parameters
    ----------
    anomaly_df    : cross-pipeline anomaly results with [period, cross_anomaly,
                    cross_anomaly_score, year_month]
    threat_monthly: monthly threat counts [year_month, cve_count, kev_count, ransomware_kev]
    """
    df = anomaly_df.merge(threat_monthly, on="year_month", how="left").sort_values("period")

    events = df[df["cross_anomaly"] == True]

    fig = go.Figure()

    # Anomaly score baseline
    fig.add_trace(
        go.Scatter(
            x=df["period"],
            y=df["cross_anomaly_score"],
            mode="lines",
            name="Cross-pipeline anomaly score",
            line=dict(color="#7f7f7f", width=1.5),
            opacity=0.8,
        )
    )

    # CVE count as secondary signal
    if "cve_count_x" in df.columns:
        df["cve_count"] = df["cve_count_x"]
    if "cve_count" in df.columns:
        norm_cve = df["cve_count"] / df["cve_count"].max() * df["cross_anomaly_score"].max()
        fig.add_trace(
            go.Scatter(
                x=df["period"],
                y=norm_cve,
                mode="lines",
                name="CVE count (normalized)",
                line=dict(color="#1f77b4", width=1, dash="dot"),
                opacity=0.6,
            )
        )

    # Anomaly event markers
    if not events.empty:
        fig.add_trace(
            go.Scatter(
                x=events["period"],
                y=events["cross_anomaly_score"],
                mode="markers+text",
                name="Anomalous month",
                marker=dict(
                    color="#d62728",
                    size=14,
                    symbol="diamond",
                    line=dict(color="white", width=1.5),
                ),
                text=events["year_month"],
                textposition="top center",
                hovertemplate=(
                    "Month: %{x|%b %Y}<br>"
                    "Score: %{y:.3f}<br>"
                    "<extra>Anomalous period</extra>"
                ),
            )
        )

        # Vertical shading for anomalous months
        for _, row in events.iterrows():
            fig.add_vrect(
                x0=row["period"],
                x1=row["period"],
                line_width=2,
                line_color="#d62728",
                opacity=0.25,
                layer="below",
            )

    fig.update_layout(
        title="Cross-Pipeline Anomaly Timeline — Threat Intelligence × Supply Chain",
        xaxis_title="Month",
        yaxis_title="Anomaly Score",
        height=440,
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
    fig.update_yaxes(showgrid=True, gridcolor="#eeeeee")
    return fig

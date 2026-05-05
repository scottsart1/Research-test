"""
ATT&CK technique heatmap: rows = tactics, columns = months,
color intensity = number of CVEs mapped to that technique in that period.
"""

import pandas as pd
import plotly.graph_objects as go


def build_attack_heatmap(
    cve_tags: pd.DataFrame,
    cve_df: pd.DataFrame,
    techniques: pd.DataFrame,
) -> go.Figure:
    """
    Parameters
    ----------
    cve_tags : per-CVE TTP assignments (from TTPTagger.tag_cves)
    cve_df   : NVD CVE dataframe with year_month column
    techniques: MITRE techniques with tactic info
    """
    merged = cve_tags[cve_tags["rank"] == 1].merge(
        cve_df[["cve_id", "year_month"]],
        on="cve_id",
        how="left",
    )
    merged = merged.dropna(subset=["year_month", "tactic"])

    # Pivot: tactic × year_month → count
    pivot = (
        merged.groupby(["tactic", "year_month"])
        .size()
        .reset_index(name="count")
        .pivot(index="tactic", columns="year_month", values="count")
        .fillna(0)
    )

    # Keep last 24 months for readability
    pivot = pivot[sorted(pivot.columns)[-24:]]

    tactic_order = [
        "reconnaissance", "resource-development", "initial-access",
        "execution", "persistence", "privilege-escalation",
        "defense-evasion", "credential-access", "discovery",
        "lateral-movement", "collection", "command-and-control",
        "exfiltration", "impact",
    ]
    ordered_index = [t for t in tactic_order if t in pivot.index] + [
        t for t in pivot.index if t not in tactic_order
    ]
    pivot = pivot.reindex(ordered_index).dropna(how="all")

    fig = go.Figure(
        data=go.Heatmap(
            z=pivot.values,
            x=list(pivot.columns),
            y=[t.replace("-", " ").title() for t in pivot.index],
            colorscale="Reds",
            colorbar=dict(title="CVE count"),
            hoverongaps=False,
            hovertemplate="Tactic: %{y}<br>Month: %{x}<br>CVEs: %{z}<extra></extra>",
        )
    )

    fig.update_layout(
        title="ATT&CK Tactic Activity Heatmap (CVEs by Month)",
        xaxis_title="Month",
        yaxis_title="ATT&CK Tactic",
        height=480,
        margin=dict(l=160, r=30, t=60, b=60),
        plot_bgcolor="white",
        font=dict(size=12),
    )
    return fig


def build_technique_bar(cve_tags: pd.DataFrame, top_n: int = 20) -> go.Figure:
    """Bar chart of top-N ATT&CK techniques by CVE count."""
    top = (
        cve_tags[cve_tags["rank"] == 1]
        .groupby(["technique_id", "technique_name"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
        .head(top_n)
    )

    colors = [
        "#d62728" if row["count"] > top["count"].quantile(0.75) else "#1f77b4"
        for _, row in top.iterrows()
    ]

    fig = go.Figure(
        go.Bar(
            x=top["count"],
            y=top["technique_id"] + ": " + top["technique_name"].str[:40],
            orientation="h",
            marker_color=colors,
            hovertemplate="%{y}<br>CVEs: %{x}<extra></extra>",
        )
    )
    fig.update_layout(
        title=f"Top {top_n} ATT&CK Techniques by CVE Volume",
        xaxis_title="Number of CVEs",
        yaxis=dict(autorange="reversed"),
        height=550,
        margin=dict(l=300, r=30, t=60, b=60),
        plot_bgcolor="white",
    )
    return fig

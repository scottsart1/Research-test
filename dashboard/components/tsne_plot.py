"""
t-SNE scatter plot of CVE document embeddings, colored by LDA topic.
Each point is a CVE; hovering shows CVE ID, topic label, and severity.
"""

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go


TOPIC_PALETTE = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
    "#aec7e8", "#ffbb78",
]


def build_tsne_scatter(
    tsne_df: pd.DataFrame,
    cve_df: pd.DataFrame,
    topic_labels: dict[int, str],
) -> go.Figure:
    """
    Parameters
    ----------
    tsne_df      : columns [cve_id, tsne_x, tsne_y, dominant_topic]
    cve_df       : columns [cve_id, cvss_severity, cvss_base_score, vendors]
    topic_labels : {topic_id: 'keyword1 / keyword2 / keyword3'}
    """
    plot_df = tsne_df.merge(
        cve_df[["cve_id", "cvss_severity", "cvss_base_score", "vendors"]],
        on="cve_id",
        how="left",
    )
    plot_df["topic_label"] = plot_df["dominant_topic"].map(topic_labels).fillna("Unknown")
    plot_df["cvss_severity"] = plot_df["cvss_severity"].fillna("N/A")

    severity_to_size = {"CRITICAL": 10, "HIGH": 7, "MEDIUM": 5, "LOW": 4, "N/A": 3}
    plot_df["marker_size"] = plot_df["cvss_severity"].map(severity_to_size).fillna(3)

    fig = px.scatter(
        plot_df,
        x="tsne_x",
        y="tsne_y",
        color="topic_label",
        size="marker_size",
        size_max=12,
        hover_data={
            "cve_id": True,
            "cvss_severity": True,
            "cvss_base_score": True,
            "vendors": True,
            "tsne_x": False,
            "tsne_y": False,
            "marker_size": False,
        },
        color_discrete_sequence=TOPIC_PALETTE,
        opacity=0.72,
    )

    fig.update_layout(
        title="CVE Cluster Map — t-SNE by LDA Topic",
        xaxis_title="t-SNE dimension 1",
        yaxis_title="t-SNE dimension 2",
        legend_title="Topic",
        height=580,
        plot_bgcolor="#f8f9fa",
        paper_bgcolor="white",
        margin=dict(l=40, r=200, t=60, b=60),
    )
    fig.update_traces(marker=dict(line=dict(width=0.3, color="rgba(0,0,0,0.3)")))
    return fig

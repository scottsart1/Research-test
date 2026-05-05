"""
MAPE-by-category bar chart for the forecast tab.
Shows model accuracy across retail segments.
"""

import pandas as pd
import plotly.graph_objects as go


def build_mape_bar(mape_df: pd.DataFrame) -> go.Figure:
    """
    Parameters
    ----------
    mape_df : DataFrame with columns [category, mape] where mape is percentage (e.g. 3.2)
    """
    df = mape_df.sort_values("mape")
    threshold = 5.0  # >5% MAPE is considered poor for monthly retail

    colors = [
        "#2ca02c" if v <= threshold else "#d62728"
        for v in df["mape"]
    ]

    fig = go.Figure(
        go.Bar(
            x=df["category"].str.replace("_", " ").str.title(),
            y=df["mape"],
            marker_color=colors,
            text=[f"{v:.1f}%" for v in df["mape"]],
            textposition="outside",
            hovertemplate="%{x}<br>MAPE: %{y:.2f}%<extra></extra>",
        )
    )

    fig.add_hline(
        y=threshold,
        line_dash="dash",
        line_color="gray",
        annotation_text=f"Threshold ({threshold}%)",
        annotation_position="right",
    )

    fig.update_layout(
        title="Forecast Accuracy by Retail Category (MAPE)",
        yaxis_title="Mean Absolute Percentage Error (%)",
        xaxis_title="Category",
        height=400,
        plot_bgcolor="white",
        margin=dict(l=60, r=60, t=60, b=100),
        showlegend=False,
    )
    fig.update_xaxes(tickangle=-35)
    return fig

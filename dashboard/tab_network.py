"""
Tab 1: CVE → TTP → Vendor network graph.
Uses PyVis to render an interactive HTML network embedded in Streamlit.
"""

import tempfile
from pathlib import Path

import pandas as pd
import streamlit as st
from pyvis.network import Network

from dashboard.components.heatmap import build_attack_heatmap, build_technique_bar
from dashboard.components.tsne_plot import build_tsne_scatter


NODE_COLORS = {
    "cve": "#AED6F1",       # light blue
    "technique": "#F1948A",  # salmon
    "vendor": "#A9DFBF",     # light green
    "kev_cve": "#E74C3C",    # red — KEV-listed CVEs
}

NODE_SIZES = {
    "cve": 12,
    "kev_cve": 18,
    "technique": 22,
    "vendor": 16,
}


def _build_network(
    edges: pd.DataFrame,
    max_nodes: int = 150,
) -> Network:
    net = Network(
        height="620px",
        width="100%",
        bgcolor="#1a1a2e",
        font_color="white",
        directed=False,
    )
    net.set_options("""
    {
      "physics": {
        "forceAtlas2Based": {
          "gravitationalConstant": -60,
          "centralGravity": 0.005,
          "springLength": 120,
          "springConstant": 0.08
        },
        "maxVelocity": 50,
        "solver": "forceAtlas2Based",
        "timestep": 0.35,
        "stabilization": {"iterations": 150}
      },
      "edges": {
        "smooth": {"type": "continuous"}
      }
    }
    """)

    seen_nodes = set()
    added = 0

    for _, row in edges.iterrows():
        if added >= max_nodes:
            break

        src = str(row["source"])
        tgt = str(row["target"])
        edge_type = row.get("edge_type", "")
        is_kev = bool(row.get("is_kev", False))

        # Add source node
        if src not in seen_nodes:
            if edge_type == "cve_to_ttp":
                color = NODE_COLORS["kev_cve"] if is_kev else NODE_COLORS["cve"]
                size = NODE_SIZES["kev_cve"] if is_kev else NODE_SIZES["cve"]
                title = f"{'⚠ KEV — ' if is_kev else ''}CVE: {src}"
                shape = "dot"
            else:
                color = NODE_COLORS["technique"]
                size = NODE_SIZES["technique"]
                title = f"TTP: {src}"
                shape = "square"
            net.add_node(src, label=src, color=color, size=size, title=title, shape=shape)
            seen_nodes.add(src)
            added += 1

        # Add target node
        if tgt not in seen_nodes:
            if edge_type == "cve_to_ttp":
                color = NODE_COLORS["technique"]
                size = NODE_SIZES["technique"]
                title = f"TTP: {tgt}"
                shape = "square"
            else:
                color = NODE_COLORS["vendor"]
                size = NODE_SIZES["vendor"]
                title = f"Vendor: {tgt}"
                shape = "triangle"
            net.add_node(tgt, label=tgt[:25], color=color, size=size, title=title, shape=shape)
            seen_nodes.add(tgt)
            added += 1

        weight = float(row.get("weight", 1.0))
        edge_color = "#E74C3C" if is_kev else "#888888"
        net.add_edge(src, tgt, width=max(1, weight * 4), color=edge_color)

    return net


def render(
    graph_edges: pd.DataFrame,
    cve_tags: pd.DataFrame,
    cve_df: pd.DataFrame,
    techniques: pd.DataFrame,
    tsne_df: pd.DataFrame | None,
    topic_labels: dict,
):
    st.subheader("CVE → TTP → Vendor Network")
    st.markdown(
        "Each node is a **CVE** (blue), **ATT&CK Technique** (salmon), or **Vendor** (green). "
        "Red nodes and edges are CISA KEV-listed vulnerabilities. "
        "Edge weight reflects TF-IDF similarity between the CVE description and technique."
    )

    # Filters
    col1, col2 = st.columns([2, 1])
    with col1:
        tactic_filter = st.multiselect(
            "Filter by tactic",
            options=sorted(cve_tags["tactic"].dropna().unique()),
            default=[],
        )
    with col2:
        max_nodes = st.slider("Max nodes displayed", 50, 300, 120, step=25)
        kev_only = st.checkbox("Show KEV-linked edges only", value=False)

    edges = graph_edges.copy()
    if kev_only:
        edges = edges[edges["is_kev"] == True]
    if tactic_filter:
        ttp_ids = cve_tags[cve_tags["tactic"].isin(tactic_filter)]["technique_id"].unique()
        mask = edges["source"].isin(ttp_ids) | edges["target"].isin(ttp_ids)
        edges = edges[mask]

    if edges.empty:
        st.info("No edges match the current filters.")
    else:
        net = _build_network(edges, max_nodes=max_nodes)
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False) as f:
            net.save_graph(f.name)
            html = open(f.name).read()
        st.components.v1.html(html, height=640, scrolling=False)

    st.divider()

    # ATT&CK heatmap
    st.subheader("ATT&CK Tactic Activity Heatmap")
    if not cve_tags.empty and not cve_df.empty:
        fig_heatmap = build_attack_heatmap(cve_tags, cve_df, techniques)
        st.plotly_chart(fig_heatmap, use_container_width=True)

    # Technique bar chart
    st.subheader("Top Techniques by CVE Volume")
    if not cve_tags.empty:
        top_n = st.slider("Top N techniques", 10, 30, 20)
        fig_bar = build_technique_bar(cve_tags, top_n=top_n)
        st.plotly_chart(fig_bar, use_container_width=True)

    # t-SNE scatter
    if tsne_df is not None and not tsne_df.empty:
        st.subheader("CVE Cluster Map (t-SNE by LDA Topic)")
        fig_tsne = build_tsne_scatter(tsne_df, cve_df, topic_labels)
        st.plotly_chart(fig_tsne, use_container_width=True)

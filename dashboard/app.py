"""
MITRE Supply Threat Watch — Streamlit Dashboard
================================================
Tab 1: Threat Intelligence Network  (CVE → TTP → Vendor graph + heatmap + t-SNE)
Tab 2: Supply Chain Forecasting     (XGBoost forecast + anomaly timeline + MAPE)
"""

import os
from pathlib import Path

import streamlit as st

# Must be the very first Streamlit call
st.set_page_config(
    page_title="MITRE Supply Threat Watch",
    page_icon="🛡️",
    layout="wide",
    initial_sidebar_state="expanded",
)

from dotenv import load_dotenv
load_dotenv()

from dashboard import tab_network, tab_forecast
from dashboard.data_loader import (
    load_anomaly_data,
    load_cve_data,
    load_cve_tags,
    load_forecasts,
    load_graph_edges,
    load_kev_data,
    load_techniques,
    load_tsne,
)


def sidebar():
    with st.sidebar:
        st.image(
            "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/"
            "MITRE_Corporation_logo.svg/320px-MITRE_Corporation_logo.svg.png",
            width=120,
        )
        st.title("MITRE Supply Threat Watch")
        st.caption("Threat-Intel NLP × Supply-Chain Forecasting")

        st.divider()
        mode = os.getenv("DASHBOARD_MODE", "local")
        st.markdown(f"**Mode:** `{mode}`")

        st.divider()
        st.markdown("**Data Sources**")
        st.markdown(
            "- [MITRE ATT&CK](https://attack.mitre.org/)\n"
            "- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)\n"
            "- [NVD CVE API](https://nvd.nist.gov/developers)\n"
            "- [FRED (St. Louis Fed)](https://fred.stlouisfed.org/)\n"
            "- [Census Bureau MART](https://www.census.gov/retail/index.html)"
        )

        st.divider()
        if st.button("🔄 Refresh data cache", use_container_width=True):
            st.cache_data.clear()
            st.rerun()


def main():
    sidebar()

    # KPI header row
    cve_df = load_cve_data()
    kev_df = load_kev_data()
    cve_tags = load_cve_tags()
    techniques = load_techniques()
    graph_edges = load_graph_edges()
    tsne_df, topic_labels = load_tsne()
    forecast_df = load_forecasts()
    anomaly_df, threat_monthly = load_anomaly_data()

    total_cves = len(cve_df)
    total_kev = len(kev_df)
    total_ttps = cve_tags["technique_id"].nunique() if not cve_tags.empty else 0
    total_anomalies = int(anomaly_df.get("cross_anomaly", pd.Series()).sum()) if not anomaly_df.empty else 0

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("CVEs Indexed", f"{total_cves:,}", help="NVD CVEs in current dataset")
    col2.metric("CISA KEV Entries", f"{total_kev:,}", help="Known Exploited Vulnerabilities")
    col3.metric("ATT&CK TTPs Tagged", f"{total_ttps:,}", help="Unique techniques mapped via TF-IDF + keywords")
    col4.metric("Anomalous Months", f"{total_anomalies}", help="Joint threat + supply-chain anomalies flagged by Isolation Forest")

    st.divider()

    tab1, tab2 = st.tabs(["🕸️ Threat Intelligence Network", "📈 Supply Chain Forecasting"])

    with tab1:
        tab_network.render(
            graph_edges=graph_edges,
            cve_tags=cve_tags,
            cve_df=cve_df,
            techniques=techniques,
            tsne_df=tsne_df if not tsne_df.empty else None,
            topic_labels=topic_labels,
        )

    with tab2:
        tab_forecast.render(
            forecast_df=forecast_df,
            anomaly_df=anomaly_df,
            threat_monthly=threat_monthly,
        )


# Avoid the circular import issue with st.cache_data and pandas
import pandas as pd  # noqa: E402

if __name__ == "__main__":
    main()

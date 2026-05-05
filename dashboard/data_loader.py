"""
Data loading layer for the Streamlit dashboard.
Reads from Snowflake (DASHBOARD_MODE=snowflake) or local parquet files (DASHBOARD_MODE=local).
All heavy computation is cached via st.cache_data.
"""

import logging
from pathlib import Path

import pandas as pd
import streamlit as st

from db.snowflake_client import read_table

logger = logging.getLogger(__name__)

LOCAL_DB = Path("data/local_db")
CACHE_DIR = Path("data/cache")
MODEL_DIR = Path("data/models")


@st.cache_data(ttl=3600, show_spinner="Loading threat intelligence data...")
def load_cve_data() -> pd.DataFrame:
    df = read_table("nvd_cves")
    if df.empty:
        path = CACHE_DIR / "nvd_cves.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    if "published" in df.columns:
        df["published"] = pd.to_datetime(df["published"], utc=True, errors="coerce")
    return df


@st.cache_data(ttl=3600, show_spinner="Loading KEV catalog...")
def load_kev_data() -> pd.DataFrame:
    df = read_table("cisa_kev")
    if df.empty:
        path = CACHE_DIR / "cisa_kev.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    return df


@st.cache_data(ttl=3600, show_spinner="Loading ATT&CK techniques...")
def load_techniques() -> pd.DataFrame:
    df = read_table("mitre_techniques")
    if df.empty:
        path = CACHE_DIR / "mitre_techniques.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    return df


@st.cache_data(ttl=3600, show_spinner="Loading CVE→TTP tags...")
def load_cve_tags() -> pd.DataFrame:
    df = read_table("cve_ttp_tags")
    if df.empty:
        path = LOCAL_DB / "cve_ttp_tags.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    return df


@st.cache_data(ttl=3600, show_spinner="Loading network graph edges...")
def load_graph_edges() -> pd.DataFrame:
    df = read_table("cve_ttp_graph_edges")
    if df.empty:
        path = LOCAL_DB / "cve_ttp_graph_edges.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    return df


@st.cache_data(ttl=3600, show_spinner="Loading t-SNE coordinates...")
def load_tsne() -> tuple[pd.DataFrame, dict]:
    path = MODEL_DIR / "tsne_coords.parquet"
    label_path = MODEL_DIR / "topic_labels.json"

    tsne_df = pd.read_parquet(path) if path.exists() else pd.DataFrame()

    topic_labels = {}
    if label_path.exists():
        import json
        with open(label_path) as f:
            raw = json.load(f)
        topic_labels = {int(k): v for k, v in raw.items()}

    return tsne_df, topic_labels


@st.cache_data(ttl=3600, show_spinner="Loading forecasts...")
def load_forecasts() -> pd.DataFrame:
    df = read_table("retail_forecasts")
    if df.empty:
        path = LOCAL_DB / "retail_forecasts.parquet"
        if path.exists():
            df = pd.read_parquet(path)
    if "period" in df.columns:
        df["period"] = pd.to_datetime(df["period"], errors="coerce")
    return df


@st.cache_data(ttl=3600, show_spinner="Loading anomaly events...")
def load_anomaly_data() -> tuple[pd.DataFrame, pd.DataFrame]:
    anomaly_df = read_table("anomaly_events")
    if anomaly_df.empty:
        path = LOCAL_DB / "anomaly_events.parquet"
        if path.exists():
            anomaly_df = pd.read_parquet(path)

    threat_path = LOCAL_DB / "threat_monthly.parquet"
    threat_df = pd.read_parquet(threat_path) if threat_path.exists() else pd.DataFrame()

    if "period" in anomaly_df.columns:
        anomaly_df["period"] = pd.to_datetime(anomaly_df["period"], errors="coerce")

    return anomaly_df, threat_df

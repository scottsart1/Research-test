"""
Fetches the CISA Known Exploited Vulnerabilities (KEV) catalog.
Source: https://www.cisa.gov/known-exploited-vulnerabilities-catalog
"""

import logging
from pathlib import Path

import pandas as pd
import requests
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
CACHE_PATH = Path("data/cache/cisa_kev.parquet")


@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=1, min=2, max=16))
def _fetch() -> dict:
    logger.info("Fetching CISA KEV catalog...")
    resp = requests.get(KEV_URL, timeout=30)
    resp.raise_for_status()
    return resp.json()


def run(use_cache: bool = True) -> pd.DataFrame:
    if use_cache and CACHE_PATH.exists():
        logger.info("Loading KEV from cache")
        return pd.read_parquet(CACHE_PATH)

    data = _fetch()
    vulns = data.get("vulnerabilities", [])

    df = pd.DataFrame(vulns)

    # Normalize column names
    df.rename(columns={
        "cveID": "cve_id",
        "vendorProject": "vendor",
        "product": "product",
        "vulnerabilityName": "vuln_name",
        "dateAdded": "date_added",
        "shortDescription": "description",
        "requiredAction": "required_action",
        "dueDate": "due_date",
        "ransomwareUse": "ransomware_use",
    }, inplace=True)

    df["date_added"] = pd.to_datetime(df["date_added"], errors="coerce")
    df["due_date"] = pd.to_datetime(df["due_date"], errors="coerce")

    # Flag ransomware-associated CVEs
    df["is_ransomware"] = df["ransomware_use"].str.lower().eq("known")

    # Derive year/quarter for time-series joins
    df["year"] = df["date_added"].dt.year
    df["quarter"] = df["date_added"].dt.quarter
    df["year_month"] = df["date_added"].dt.to_period("M").astype(str)

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(CACHE_PATH, index=False)
    logger.info(f"KEV catalog: {len(df)} vulnerabilities")
    return df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    df = run()
    print(df.dtypes)
    print(df.head())
    print(f"\nRansomware-associated: {df['is_ransomware'].sum()}")
    print(f"\nTop vendors:\n{df['vendor'].value_counts().head(10)}")

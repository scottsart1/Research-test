"""
Fetches CVE records from the NVD API v2.
Paginates through results for a given date range or keyword search.
Docs: https://nvd.nist.gov/developers/vulnerabilities
"""

import logging
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import requests
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

NVD_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0"
CACHE_PATH = Path("data/cache/nvd_cves.parquet")

# NVD rate limits: 5 req/30s without key, 50 req/30s with key
RATE_LIMIT_SLEEP = 6  # seconds between requests (conservative without key)


def _build_headers() -> dict:
    key = os.getenv("NVD_API_KEY", "")
    if key:
        return {"apiKey": key}
    return {}


@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=2, min=4, max=30))
def _fetch_page(params: dict, headers: dict) -> dict:
    resp = requests.get(NVD_BASE, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _parse_cve_item(item: dict) -> dict:
    cve = item.get("cve", {})
    cve_id = cve.get("id", "")

    # Description (prefer English)
    descs = cve.get("descriptions", [])
    desc = next((d["value"] for d in descs if d.get("lang") == "en"), "")

    # CVSS scores
    metrics = cve.get("metrics", {})
    cvss_v3 = metrics.get("cvssMetricV31", metrics.get("cvssMetricV30", []))
    base_score = None
    severity = None
    if cvss_v3:
        cvss_data = cvss_v3[0].get("cvssData", {})
        base_score = cvss_data.get("baseScore")
        severity = cvss_data.get("baseSeverity")

    # CPE / affected products
    configs = cve.get("configurations", [])
    vendors = set()
    products = set()
    for config in configs:
        for node in config.get("nodes", []):
            for cpe_match in node.get("cpeMatch", []):
                uri = cpe_match.get("criteria", "")
                parts = uri.split(":")
                if len(parts) >= 5:
                    vendors.add(parts[3])
                    products.add(parts[4])

    # CWE
    weaknesses = cve.get("weaknesses", [])
    cwes = []
    for w in weaknesses:
        for d in w.get("description", []):
            if d.get("lang") == "en":
                cwes.append(d.get("value", ""))

    return {
        "cve_id": cve_id,
        "description": desc[:600],
        "published": cve.get("published", ""),
        "last_modified": cve.get("lastModified", ""),
        "status": cve.get("vulnStatus", ""),
        "cvss_base_score": base_score,
        "cvss_severity": severity,
        "cwe": "|".join(cwes[:3]),
        "vendors": "|".join(list(vendors)[:5]),
        "products": "|".join(list(products)[:5]),
    }


def fetch_cves(
    days_back: int = 365,
    max_results: int = 5000,
    use_cache: bool = True,
) -> pd.DataFrame:
    if use_cache and CACHE_PATH.exists():
        logger.info("Loading NVD CVEs from cache")
        return pd.read_parquet(CACHE_PATH)

    headers = _build_headers()
    end_date = datetime.utcnow()
    start_date = end_date - timedelta(days=days_back)

    params_base = {
        "pubStartDate": start_date.strftime("%Y-%m-%dT00:00:00.000"),
        "pubEndDate": end_date.strftime("%Y-%m-%dT23:59:59.999"),
        "resultsPerPage": 2000,
        "startIndex": 0,
    }

    rows = []
    start_index = 0

    while True:
        params = {**params_base, "startIndex": start_index}
        logger.info(f"Fetching NVD CVEs: offset={start_index}")

        data = _fetch_page(params, headers)
        total = data.get("totalResults", 0)
        vulns = data.get("vulnerabilities", [])

        for item in vulns:
            rows.append(_parse_cve_item(item))

        start_index += len(vulns)
        if start_index >= min(total, max_results) or not vulns:
            break

        time.sleep(RATE_LIMIT_SLEEP)

    df = pd.DataFrame(rows)
    df["published"] = pd.to_datetime(df["published"], errors="coerce", utc=True)
    df["last_modified"] = pd.to_datetime(df["last_modified"], errors="coerce", utc=True)
    df["year_month"] = df["published"].dt.to_period("M").astype(str)

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(CACHE_PATH, index=False)
    logger.info(f"Fetched {len(df)} CVEs from NVD")
    return df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    df = fetch_cves(days_back=365, max_results=3000)
    print(f"Total CVEs: {len(df)}")
    print(df[["cve_id", "cvss_base_score", "cvss_severity", "vendors"]].head(10))

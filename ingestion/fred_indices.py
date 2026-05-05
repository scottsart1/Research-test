"""
Fetches supply-chain and retail indicators from the FRED API.

Series used:
  GSCPI  - Global Supply Chain Pressure Index (NY Fed)
  RSXFS  - Advance Retail Sales: Food Services & Clothing (Census via FRED)
  MRTSSM44X72USS - Retail & Food Services, Excluding Motor Vehicle Parts
  CPIAUCSL - CPI All Urban Consumers (inflation adjustment)
  PAYEMS - Total nonfarm payrolls (macro context)
"""

import logging
import os
from pathlib import Path

import pandas as pd
import requests
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"
CACHE_DIR = Path("data/cache")

SERIES = {
    "GSCPI": "global_supply_chain_pressure_index",
    "RSXFS": "retail_sales_excl_food",
    "MRTSSM44X72USS": "retail_food_services",
    "CPIAUCSL": "cpi_all_urban",
    "PAYEMS": "nonfarm_payrolls",
    "ISRATIO": "inventory_sales_ratio",
}


@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=1, min=2, max=16))
def _fetch_series(series_id: str, api_key: str, start: str = "2015-01-01") -> pd.DataFrame:
    params = {
        "series_id": series_id,
        "api_key": api_key,
        "file_type": "json",
        "observation_start": start,
    }
    resp = requests.get(FRED_BASE, params=params, timeout=15)
    resp.raise_for_status()
    obs = resp.json().get("observations", [])
    df = pd.DataFrame(obs)[["date", "value"]]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["date"] = pd.to_datetime(df["date"])
    df.rename(columns={"value": series_id}, inplace=True)
    return df.set_index("date")


def run(use_cache: bool = True, start_date: str = "2015-01-01") -> pd.DataFrame:
    cache_path = CACHE_DIR / "fred_series.parquet"
    if use_cache and cache_path.exists():
        logger.info("Loading FRED data from cache")
        return pd.read_parquet(cache_path)

    api_key = os.getenv("FRED_API_KEY", "")
    if not api_key:
        logger.warning("FRED_API_KEY not set — using demo key (limited)")
        # FRED allows unauthenticated access for basic reads but it's unreliable
        api_key = "abcdefghijklmnopqrstuvwxyz123456"  # placeholder; replace in .env

    frames = []
    for series_id, label in SERIES.items():
        try:
            df = _fetch_series(series_id, api_key, start=start_date)
            df.columns = [label]
            frames.append(df)
            logger.info(f"  {series_id}: {len(df)} observations")
        except Exception as e:
            logger.warning(f"Failed to fetch {series_id}: {e}")

    if not frames:
        raise RuntimeError("Could not fetch any FRED series — check FRED_API_KEY")

    combined = pd.concat(frames, axis=1)
    combined = combined.resample("MS").mean()  # align to month-start
    combined.reset_index(inplace=True)
    combined.rename(columns={"date": "period"}, inplace=True)
    combined["year_month"] = combined["period"].dt.to_period("M").astype(str)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(cache_path, index=False)
    logger.info(f"FRED data: {len(combined)} months, {combined.shape[1]} series")
    return combined


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    df = run()
    print(df.tail(12).to_string())

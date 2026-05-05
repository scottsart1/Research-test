"""
Fetches and parses the MITRE ATT&CK Enterprise framework (STIX 2.1 bundle).
Extracts techniques, tactics, groups, and software with their relationships.
"""

import json
import logging
import time
from pathlib import Path

import pandas as pd
import requests
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

ATTACK_URL = (
    "https://raw.githubusercontent.com/mitre/cti/master/"
    "enterprise-attack/enterprise-attack.json"
)
CACHE_PATH = Path("data/cache/mitre_attack.json")


@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=1, min=2, max=16))
def _fetch_bundle() -> dict:
    logger.info("Downloading MITRE ATT&CK bundle...")
    resp = requests.get(ATTACK_URL, timeout=60)
    resp.raise_for_status()
    return resp.json()


def load_bundle(use_cache: bool = True) -> dict:
    if use_cache and CACHE_PATH.exists():
        logger.info("Loading ATT&CK bundle from cache")
        with open(CACHE_PATH) as f:
            return json.load(f)

    bundle = _fetch_bundle()
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_PATH, "w") as f:
        json.dump(bundle, f)
    return bundle


def _get_objects_by_type(bundle: dict, obj_type: str) -> list[dict]:
    return [o for o in bundle["objects"] if o.get("type") == obj_type]


def parse_techniques(bundle: dict) -> pd.DataFrame:
    """Extract attack-pattern objects → techniques table."""
    rows = []
    for obj in _get_objects_by_type(bundle, "attack-pattern"):
        if obj.get("revoked") or obj.get("x_mitre_deprecated"):
            continue

        ext = obj.get("external_references", [])
        mitre_ref = next((r for r in ext if r.get("source_name") == "mitre-attack"), {})
        technique_id = mitre_ref.get("external_id", "")
        url = mitre_ref.get("url", "")

        tactics = [
            kc["phase_name"] for kc in obj.get("kill_chain_phases", [])
            if kc.get("kill_chain_name") == "mitre-attack"
        ]

        rows.append({
            "technique_id": technique_id,
            "technique_name": obj.get("name", ""),
            "description": obj.get("description", "")[:500],
            "tactics": "|".join(tactics),
            "platforms": "|".join(obj.get("x_mitre_platforms", [])),
            "data_sources": "|".join(obj.get("x_mitre_data_sources", [])),
            "stix_id": obj.get("id", ""),
            "url": url,
        })

    df = pd.DataFrame(rows)
    logger.info(f"Parsed {len(df)} techniques from ATT&CK")
    return df


def parse_groups(bundle: dict) -> pd.DataFrame:
    """Extract intrusion-set objects → threat actor groups."""
    rows = []
    for obj in _get_objects_by_type(bundle, "intrusion-set"):
        if obj.get("revoked"):
            continue
        ext = obj.get("external_references", [])
        mitre_ref = next((r for r in ext if r.get("source_name") == "mitre-attack"), {})
        aliases = obj.get("aliases", [])
        rows.append({
            "group_id": mitre_ref.get("external_id", ""),
            "group_name": obj.get("name", ""),
            "aliases": "|".join(aliases),
            "description": obj.get("description", "")[:300],
            "stix_id": obj.get("id", ""),
        })

    return pd.DataFrame(rows)


def parse_software(bundle: dict) -> pd.DataFrame:
    """Extract malware and tool objects → software table."""
    rows = []
    for obj_type in ("malware", "tool"):
        for obj in _get_objects_by_type(bundle, obj_type):
            if obj.get("revoked"):
                continue
            ext = obj.get("external_references", [])
            mitre_ref = next((r for r in ext if r.get("source_name") == "mitre-attack"), {})
            rows.append({
                "software_id": mitre_ref.get("external_id", ""),
                "software_name": obj.get("name", ""),
                "software_type": obj_type,
                "platforms": "|".join(obj.get("x_mitre_platforms", [])),
                "description": obj.get("description", "")[:300],
                "stix_id": obj.get("id", ""),
            })

    return pd.DataFrame(rows)


def parse_relationships(bundle: dict) -> pd.DataFrame:
    """Extract relationship objects — links techniques to groups/software."""
    rows = []
    for obj in _get_objects_by_type(bundle, "relationship"):
        if obj.get("revoked"):
            continue
        rows.append({
            "relationship_type": obj.get("relationship_type", ""),
            "source_ref": obj.get("source_ref", ""),
            "target_ref": obj.get("target_ref", ""),
            "stix_id": obj.get("id", ""),
        })

    return pd.DataFrame(rows)


def run(use_cache: bool = True) -> dict[str, pd.DataFrame]:
    bundle = load_bundle(use_cache)
    return {
        "techniques": parse_techniques(bundle),
        "groups": parse_groups(bundle),
        "software": parse_software(bundle),
        "relationships": parse_relationships(bundle),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    tables = run()
    for name, df in tables.items():
        print(f"\n=== {name} ({len(df)} rows) ===")
        print(df.head(3).to_string())

"""
Snowflake connection and bulk-write utilities.
Supports both authenticated Snowflake and local-mode (no-op / parquet) operation.
"""

import logging
import os
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

LOCAL_DATA_DIR = Path("data/local_db")


def is_local_mode() -> bool:
    return os.getenv("DASHBOARD_MODE", "local").lower() == "local"


def get_connection():
    """Return a Snowflake connection object. Raises if credentials are missing."""
    try:
        import snowflake.connector
    except ImportError:
        raise RuntimeError("snowflake-connector-python not installed")

    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        password=os.environ["SNOWFLAKE_PASSWORD"],
        database=os.environ.get("SNOWFLAKE_DATABASE", "THREAT_SUPPLY_DB"),
        schema=os.environ.get("SNOWFLAKE_SCHEMA", "PUBLIC"),
        warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH"),
        role=os.environ.get("SNOWFLAKE_ROLE", "SYSADMIN"),
    )


def write_table(df: pd.DataFrame, table_name: str, if_exists: str = "replace"):
    """
    Write a DataFrame to either Snowflake or local parquet, depending on mode.
    if_exists: 'replace' or 'append'
    """
    if is_local_mode():
        _write_local(df, table_name)
        return

    try:
        from snowflake.connector.pandas_tools import write_pandas
        conn = get_connection()
        success, nchunks, nrows, _ = write_pandas(
            conn,
            df,
            table_name=table_name.upper(),
            auto_create_table=False,
            overwrite=(if_exists == "replace"),
        )
        logger.info(f"Snowflake write: {table_name} — {nrows} rows, {nchunks} chunks")
        conn.close()
    except Exception as e:
        logger.error(f"Snowflake write failed for {table_name}: {e}")
        logger.info("Falling back to local parquet")
        _write_local(df, table_name)


def read_table(table_name: str, query: str | None = None) -> pd.DataFrame:
    """Read from Snowflake or local parquet depending on mode."""
    if is_local_mode():
        return _read_local(table_name)

    try:
        conn = get_connection()
        sql = query or f"SELECT * FROM {table_name.upper()} LIMIT 50000"
        df = pd.read_sql(sql, conn)
        conn.close()
        return df
    except Exception as e:
        logger.error(f"Snowflake read failed for {table_name}: {e}")
        return _read_local(table_name)


def _write_local(df: pd.DataFrame, table_name: str):
    LOCAL_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = LOCAL_DATA_DIR / f"{table_name}.parquet"
    df.to_parquet(path, index=False)
    logger.info(f"Local write: {path} ({len(df)} rows)")


def _read_local(table_name: str) -> pd.DataFrame:
    path = LOCAL_DATA_DIR / f"{table_name}.parquet"
    if not path.exists():
        logger.warning(f"Local table not found: {path}")
        return pd.DataFrame()
    return pd.read_parquet(path)


def run_ddl(sql_path: str | None = None):
    """Execute the schema DDL against Snowflake (skipped in local mode)."""
    if is_local_mode():
        logger.info("Local mode: skipping DDL execution")
        return

    if sql_path is None:
        sql_path = str(Path(__file__).parent / "schema.sql")

    with open(sql_path) as f:
        raw_sql = f.read()

    # Split on semicolons and execute each statement
    statements = [s.strip() for s in raw_sql.split(";") if s.strip()]
    conn = get_connection()
    cursor = conn.cursor()
    for stmt in statements:
        if not stmt or stmt.startswith("--"):
            continue
        try:
            cursor.execute(stmt)
        except Exception as e:
            logger.warning(f"DDL statement failed (likely already exists): {e}")
    cursor.close()
    conn.close()
    logger.info("Schema DDL executed")

"""
Supabase data download utilities.
"""

import logging

import pandas as pd

from .client import get_supabase_client

logger = logging.getLogger(__name__)


def get_existing_df_supabase(table_name: str, batch_size: int = 10000) -> pd.DataFrame | None:
    """
    Fetch all data from a Supabase table and return as pandas DataFrame.

    Args:
        table_name: Name of the table to fetch data from
        batch_size: Number of records to fetch per batch

    Returns:
        pandas DataFrame with the data or None if failed
    """
    supabase = get_supabase_client()
    if not supabase:
        return None

    all_data = []
    offset = 0

    try:
        while True:
            logger.info(
                "Fetching batch starting at offset %s with batch size %s", offset, batch_size
            )

            # Deterministic ordering to prevent skipping/overlap between pages
            query = supabase.table(table_name).select("*")
            # Prefer ordering by 'id' if present; fall back to 'timestamp'
            try:
                result = query.order("id").range(offset, offset + batch_size - 1).execute()
            except Exception:
                logger.exception("Error ordering by id")
                result = query.order("timestamp").range(offset, offset + batch_size - 1).execute()

            if not hasattr(result, "data") or not result.data:
                logger.info("No more data to fetch")
                break

            batch_data = result.data
            all_data.extend(batch_data)

            logger.info(
                "Fetched %s records in this batch. Total records so far: %s",
                len(batch_data),
                len(all_data),
            )

            if len(batch_data) < batch_size:
                logger.info("Reached end of data")
                break

            offset += batch_size
    except Exception:
        logger.exception("Error fetching data from Supabase")
        return None
    else:
        if all_data:
            logger.info("Total records fetched: %s", len(all_data))
            return pd.DataFrame(all_data)

        logger.warning("No data found in the database")
        return None

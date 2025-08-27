"""
Supabase data upload utilities.
"""

import logging
import time
from datetime import datetime
from typing import Any

from .client import Client, get_supabase_client

logger = logging.getLogger(__name__)


def normalize_data_for_supabase(data: list[dict]) -> list[dict]:
    """
    Normalize data to be JSON serializable for Supabase.
    Converts datetime objects to ISO format strings.

    Args:
        data: List of dictionaries that may contain datetime objects

    Returns:
        List of dictionaries with datetime objects converted to ISO strings
    """
    normalized_data = []

    for record in data:
        normalized_record = {}
        for key, value in record.items():
            if isinstance(value, datetime):
                # Convert datetime to ISO format string
                # If datetime has timezone info, use isoformat() directly
                # If no timezone info, assume UTC and add Z
                if value.tzinfo is not None:
                    normalized_record[key] = value.isoformat()
                else:
                    normalized_record[key] = value.isoformat() + "Z"
            else:
                normalized_record[key] = value
        normalized_data.append(normalized_record)

    return normalized_data


def insert_batch_to_supabase(data: list[dict], table_name: str, batch_size: int = 10000) -> bool:
    """
    Insert batch data to Supabase table.

    Args:
        data: List of dictionaries to insert
        table_name: Name of the Supabase table
        batch_size: Number of records to insert per batch

    Returns:
        True if successful, False otherwise
    """
    supabase = get_supabase_client()
    if not supabase:
        return False

    try:
        # Normalize data to be JSON serializable
        normalized_data = normalize_data_for_supabase(data)

        total_records = len(normalized_data)
        logger.info(
            "Starting batch insertion of %s records to table '%s'", total_records, table_name
        )

        # Process data in batches
        for i in range(0, total_records, batch_size):
            batch = normalized_data[i : i + batch_size]
            batch_num = (i // batch_size) + 1
            total_batches = (total_records + batch_size - 1) // batch_size

            logger.info("Inserting batch %s/%s (%s records)", batch_num, total_batches, len(batch))

            # Insert the batch
            result = supabase.table(table_name).insert(batch).execute()

            if hasattr(result, "data") and result.data:
                logger.info("Successfully inserted batch %s (%s records)", batch_num, len(batch))
            else:
                logger.error("Failed to insert batch %s", batch_num)
                return False

            # Small delay to avoid overwhelming the API
            time.sleep(0.1)

    except Exception:
        logger.exception("Error inserting data to Supabase")
        return False
    else:
        logger.info("Successfully inserted all %s records to Supabase", total_records)
        return True


def insert_from_csv_to_supabase(
    csv_file_path: str, table_name: str = "moneymentum_test", batch_size: int = 100
) -> bool:
    """
    Insert data from CSV file to Supabase.

    Args:
        csv_file_path: Path to the CSV file
        table_name: Name of the Supabase table
        batch_size: Number of records to insert per batch

    Returns:
        True if successful, False otherwise
    """
    try:
        import pandas as pd

        # Read CSV file
        logger.info("Reading CSV file: %s", csv_file_path)
        dataframe = pd.read_csv(csv_file_path)

        # Convert DataFrame to list of dictionaries
        data = dataframe.to_dict("records")

        logger.info("Loaded %s records from CSV", len(data))

        # Insert to Supabase
        return insert_batch_to_supabase(data, table_name, batch_size)

    except Exception:
        logger.exception("Error reading CSV file")
        return False


def delete_records_from_supabase_by_timestamp_and_symbol(
    table_name: str, symbol: str, earliest_timestamp: datetime
) -> bool:
    """
    Delete records from Supabase table for a specific symbol with timestamps >= earliest_timestamp.

    Args:
        table_name: Name of the Supabase table
        symbol: Symbol to filter by
        earliest_timestamp: Delete records with timestamp >= this value

    Returns:
        True if successful, False otherwise
    """
    supabase = get_supabase_client()
    if not supabase:
        return False

    try:
        # Convert datetime to ISO format string for Supabase query
        if earliest_timestamp.tzinfo is not None:
            timestamp_str = earliest_timestamp.isoformat()
        else:
            timestamp_str = earliest_timestamp.isoformat() + "Z"

        logger.info(
            "Deleting records from table '%s' for symbol '%s' with timestamp >= %s",
            table_name,
            symbol,
            timestamp_str,
        )

        # Delete records matching the criteria
        result = (
            supabase.table(table_name)
            .delete()
            .eq("symbol", symbol)
            .gte("timestamp", timestamp_str)
            .execute()
        )

    except Exception:
        logger.exception("Error deleting records from Supabase")
        return False
    else:
        success = hasattr(result, "data")
        if success:
            logger.info(
                "Successfully deleted records for symbol '%s' with timestamp >= %s",
                symbol,
                timestamp_str,
            )
            return True

        logger.error("Failed to delete records for symbol '%s'", symbol)
        return False


def update_close_prices_batch_in_supabase(table_name: str, updates: list[dict[str, Any]]) -> bool:
    """
    Update close prices for multiple symbols in Supabase.

    Args:
        table_name: Name of the Supabase table
        updates: List of dictionaries with keys: symbol, close_price, timestamp

    Returns:
        True if all updates successful, False otherwise
    """
    supabase = get_supabase_client()
    if not supabase:
        return False

    try:
        normalized_updates = normalize_data_for_supabase(updates)

        logger.info(
            "Updating close prices for %s records in table '%s'",
            len(normalized_updates),
            table_name,
        )

        batch_size = 100
        all_success = True

        for i in range(0, len(normalized_updates), batch_size):
            batch = normalized_updates[i : i + batch_size]
            if not _apply_close_updates_batch(supabase, table_name, batch):
                all_success = False

    except Exception:
        logger.exception("Error updating close prices in Supabase")
        return False
    else:
        if all_success:
            logger.info("Successfully updated all close prices")
        else:
            logger.error("Some close price updates failed")

        return all_success


def _apply_close_updates_batch(
    supabase_client: Client, table_name: str, batch: list[dict[str, Any]]
) -> bool:
    """Apply a batch of close updates; return True if all succeed."""
    batch_success = True
    for update in batch:
        result = (
            supabase_client.table(table_name)
            .update({"close": update["close_price"]})
            .eq("symbol", update["symbol"])
            .eq("timestamp", update["timestamp"])
            .execute()
        )
        success = hasattr(result, "data") and result.data
        if not success:
            logger.error(
                "Failed to update close price for symbol '%s' at timestamp %s",
                update["symbol"],
                update["timestamp"],
            )
            batch_success = False
    return batch_success

import asyncio
import logging
import sys
from pathlib import Path

import pandas as pd
from colorama import Fore, Style, init
from pyspark.sql import DataFrame

# Add parent directory to Python path to import yang module
sys.path.append(str(Path(__file__).parent.parent))

from yang import util
from yang.dataloader.hyperliquid.funding_rates import SchemaFundingRate
from yang.dataloader.hyperliquid.ohlcv import SchemaOHLCV
from yang.supabase import get_existing_df_supabase

# Table to schema mapping
TABLE_SCHEMA_MAP = {
    "funding_rate1h": SchemaFundingRate,
    "ohlcv1h": SchemaOHLCV,
    "ohlcv15m": SchemaOHLCV,
}

# Initialize colorama for cross-platform colored output
init(autoreset=True)


# Configure logging with colors
class ColoredFormatter(logging.Formatter):
    """Custom formatter that adds colors to log messages."""

    COLORS = {
        "DEBUG": Fore.CYAN,
        "INFO": Fore.GREEN,
        "WARNING": Fore.YELLOW,
        "ERROR": Fore.RED,
        "CRITICAL": Fore.RED + Style.BRIGHT,
    }

    def format(self, record: logging.LogRecord) -> str:
        # Add color to the level name
        levelname = record.levelname
        if levelname in self.COLORS:
            record.levelname = f"{self.COLORS[levelname]}{levelname}{Style.RESET_ALL}"

        # Add color to the message based on level
        if levelname in {"ERROR", "CRITICAL"}:
            record.msg = f"{Fore.RED}{record.msg}{Style.RESET_ALL}"
        elif levelname == "WARNING":
            record.msg = f"{Fore.YELLOW}{record.msg}{Style.RESET_ALL}"
        elif levelname == "INFO":
            record.msg = f"{Fore.GREEN}{record.msg}{Style.RESET_ALL}"

        return super().format(record)


# Set up logger with colored output
logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)

# Create console handler with colored formatter
console_handler = logging.StreamHandler()
console_handler.setLevel(util.LOG_LEVEL)
formatter = ColoredFormatter("%(levelname)s: %(message)s")
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)


def _normalize_timestamps(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize timestamp column to UTC datetime without timezone info."""
    df["timestamp"] = pd.to_datetime(df["timestamp"], format="mixed", utc=True).dt.tz_localize(None)
    return df


def _clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the DataFrame by removing unnecessary columns and resetting index."""
    original_count = len(df)
    logger.info("%s Original row count: %s%s", Fore.CYAN, Fore.WHITE, original_count)

    # Remove the 'id' column if present
    if "id" in df.columns:
        df_cleaned = df.drop("id", axis=1)
        logger.info("%s Removed 'id' column", Fore.BLUE)

    # Reset index to remove the unnamed index column
    df_cleaned = df_cleaned.reset_index(drop=True)

    # Check for pre-normalization duplicates
    pre_dups_removed = original_count - len(df_cleaned.drop_duplicates())
    if pre_dups_removed > 0:
        logger.warning(
            "%s Pre-normalization duplicate rows removed: %s%s",
            Fore.YELLOW,
            Fore.WHITE,
            pre_dups_removed,
        )

    logger.info(
        "%s DataFrame columns after cleanup: %s%s",
        Fore.CYAN,
        Fore.WHITE,
        df_cleaned.columns.tolist(),
    )
    logger.info("%s DataFrame shape: %s%s", Fore.CYAN, Fore.WHITE, df_cleaned.shape)

    return df_cleaned


def _validate_timestamps_and_duplicates(df: pd.DataFrame) -> None:
    """Validate timestamps and check for duplicates."""
    # Check for null timestamps
    if "timestamp" in df.columns:
        null_timestamps = int(df["timestamp"].isna().sum())
        if null_timestamps > 0:
            logger.warning(
                "%s Rows with null/invalid timestamps: %s%s",
                Fore.YELLOW,
                Fore.WHITE,
                null_timestamps,
            )
        else:
            logger.info("%s No null timestamps found", Fore.GREEN)

    # Check for key duplicates
    if {"timestamp", "symbol"}.issubset(df.columns):
        key_dups = int(df.duplicated(subset=["timestamp", "symbol"]).sum())
        if key_dups > 0:
            logger.warning(
                "%s Duplicate rows by (timestamp, symbol): %s%s", Fore.YELLOW, Fore.WHITE, key_dups
            )
        else:
            logger.info("%s No duplicate keys found", Fore.GREEN)


def _remove_final_duplicates(df: pd.DataFrame) -> pd.DataFrame:
    """Remove final duplicates and log the results."""
    final_count_before_dedup = len(df)
    df_no_dups = df.drop_duplicates()
    final_count_after_dedup = len(df_no_dups)
    removed_count = final_count_before_dedup - final_count_after_dedup

    if removed_count > 0:
        logger.warning(
            "%s Final deduplication removed %s%s rows (before: %s, after: %s)",
            Fore.YELLOW,
            Fore.WHITE,
            removed_count,
            final_count_before_dedup,
            final_count_after_dedup,
        )
    else:
        logger.info("%s No final duplicates found", Fore.GREEN)

    return df_no_dups


def convert_to_spark_df(existing_df: pd.DataFrame | None, table_name: str) -> DataFrame:
    """Convert pandas DataFrame to Spark DataFrame with proper schema based on table name."""
    spark = util.get_spark()

    # Get the appropriate schema for the table
    schema = TABLE_SCHEMA_MAP.get(table_name)
    if schema is None:
        logger.error("%s Unknown table name: %s%s", Fore.RED, Fore.WHITE, table_name)
        logger.info(
            "%s Available tables: %s%s", Fore.CYAN, Fore.WHITE, list(TABLE_SCHEMA_MAP.keys())
        )
        error_msg = f"Unknown table: {table_name}"
        raise ValueError(error_msg)

    if existing_df is None or existing_df.empty:
        logger.warning("%s No data received from Supabase", Fore.YELLOW)
        return spark.createDataFrame([], schema=schema)

    logger.info(
        "%s Processing DataFrame with schema for table: %s%s", Fore.BLUE, Fore.WHITE, table_name
    )

    # Clean the DataFrame
    cleaned_df = _clean_dataframe(existing_df)

    # Normalize timestamps
    logger.info("%s Normalizing timestamps...", Fore.BLUE)
    normalized_df = _normalize_timestamps(cleaned_df)

    # Validate timestamps and check for duplicates
    _validate_timestamps_and_duplicates(normalized_df)

    # Remove final duplicates
    final_df = _remove_final_duplicates(normalized_df)

    # Convert to Spark DataFrame
    logger.info("%s Converting to Spark DataFrame...", Fore.BLUE)
    spark_df_return = spark.createDataFrame(final_df, schema=schema).cache()

    # Verify Spark conversion
    spark_count = spark_df_return.count()
    logger.info("%s Spark DataFrame row count: %s%s", Fore.GREEN, Fore.WHITE, spark_count)

    return spark_df_return.orderBy("timestamp")


def _fetch_data_from_supabase(table_name: str, batch_size: int) -> pd.DataFrame | None:
    """Fetch data from Supabase table."""
    logger.info("%s Fetching data from table: %s%s", Fore.BLUE, Fore.WHITE, table_name)

    try:
        existing_df = get_existing_df_supabase(table_name, batch_size)
    except Exception:
        logger.exception("%s Error fetching data from Supabase")
        return None
    else:
        if existing_df is None:
            logger.error("%s Failed to fetch data from Supabase", Fore.RED)
            return None

        logger.info(
            "%s Successfully fetched %s%s records from Supabase",
            Fore.GREEN,
            Fore.WHITE,
            len(existing_df),
        )
        return existing_df


def _save_to_csv(filename: str, spark_df: DataFrame) -> None:
    """Save Spark DataFrame to CSV file in the data folder."""
    # Get the project root directory
    project_root = Path(__file__).parent.parent
    data_folder = project_root / "data"

    # Ensure data folder exists
    data_folder.mkdir(exist_ok=True)

    # Create full path for the CSV file
    csv_path = data_folder / f"{filename}.csv"

    logger.info("%s Saving data to CSV: %s%s", Fore.BLUE, Fore.WHITE, csv_path)

    try:
        # Convert Spark DataFrame to pandas and save to CSV
        pandas_df = spark_df.toPandas()
        pandas_df.to_csv(csv_path, index=False)
        logger.info("%s Data successfully saved to CSV", Fore.GREEN)
    except Exception:
        logger.exception("%s Error saving to CSV")


async def get_funding_rate_df_supabase() -> None:
    """Main function to fetch data from Supabase and save to CSV."""
    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s 📊 Supabase Data Download Utility", Fore.BLUE)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    # Show available table options
    logger.info("%s Available tables:", Fore.CYAN)
    for i, table_name in enumerate(TABLE_SCHEMA_MAP.keys(), 1):
        schema_type = "SchemaFundingRate" if table_name == "funding_rate1h" else "SchemaOHLCV"
        logger.info("%s) %s (%s%s)", i, table_name, Fore.YELLOW, schema_type)

    # Get table selection from user input
    logger.info("%s Select a table (1-3) or enter table name directly:", Fore.CYAN)
    table_input = input(f"{Fore.WHITE}Selection: ").strip()

    # Handle numeric selection
    if table_input.isdigit():
        table_index = int(table_input) - 1
        available_tables = list(TABLE_SCHEMA_MAP.keys())
        if 0 <= table_index < len(available_tables):
            table_name = available_tables[table_index]
        else:
            logger.error("%s Invalid selection! Please choose 1-3", Fore.RED)
            return
    else:
        # Handle direct table name input
        table_name = table_input

    if not table_name:
        logger.error("%s Please provide a table name!", Fore.RED)
        return

    # Validate table name
    if table_name not in TABLE_SCHEMA_MAP:
        logger.error("%s Invalid table name: %s%s", Fore.RED, Fore.WHITE, table_name)
        logger.info(
            "%s Available tables: %s%s", Fore.CYAN, Fore.WHITE, list(TABLE_SCHEMA_MAP.keys())
        )
        return

    logger.info("%s Using table: %s%s, batch size: 10000", Fore.BLUE, Fore.WHITE, table_name)

    # Fetch data from Supabase
    existing_df = _fetch_data_from_supabase(table_name, 10000)
    if existing_df is None:
        logger.error("%s Cannot proceed without data from Supabase", Fore.RED)
        return

    # Convert to Spark DataFrame
    logger.info("%s Converting to Spark DataFrame...", Fore.BLUE)
    spark_df = convert_to_spark_df(existing_df, table_name)

    # Generate filename based on table name
    filename = f"{table_name}_supabase"

    # Save to CSV
    _save_to_csv(filename, spark_df)

    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s ✅ Download and processing completed successfully!", Fore.GREEN)
    logger.info("%s%s", Fore.BLUE, "=" * 60)


if __name__ == "__main__":
    asyncio.run(get_funding_rate_df_supabase())

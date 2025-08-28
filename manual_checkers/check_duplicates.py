import logging
import sys
from pathlib import Path
from typing import Any

import pandas as pd
from colorama import Fore, Style, init

# Add parent directory to Python path to import yang module
sys.path.append(str(Path(__file__).parent.parent))

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
logger.setLevel(logging.INFO)

# Create console handler with colored formatter
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
formatter = ColoredFormatter("%(levelname)s: %(message)s")
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)


def _get_available_files() -> list[str]:
    """Get list of available CSV files in the data folder."""
    project_root = Path(__file__).parent.parent
    data_folder = project_root / "data"

    if not data_folder.exists():
        logger.error("%s Data folder not found at: %s", Fore.RED, data_folder)
        return []

    csv_files = [f.name for f in data_folder.iterdir() if f.is_file() and f.name.endswith(".csv")]
    return sorted(csv_files)


def _check_timestamp_symbol_duplicates(dataframe: pd.DataFrame, filename: str) -> dict[str, Any]:
    """Check for duplicates based on timestamp and symbol combination."""
    results = {
        "has_duplicates": False,
        "duplicate_count": 0,
        "duplicate_details": [],
        "total_records": len(dataframe),
    }

    # Check for timestamp+symbol duplicates
    if "timestamp" in dataframe.columns and "symbol" in dataframe.columns:
        duplicates = dataframe.duplicated(subset=["timestamp", "symbol"], keep=False)
        duplicate_count = duplicates.sum()

        if duplicate_count > 0:
            results["has_duplicates"] = True
            results["duplicate_count"] = duplicate_count

            # Get details of duplicates
            duplicate_records = dataframe[duplicates].sort_values(["symbol", "timestamp"])
            duplicate_groups = duplicate_records.groupby(["symbol", "timestamp"])

            for (symbol, timestamp), group in duplicate_groups:
                if len(group) > 1:
                    results["duplicate_details"].append(
                        {
                            "symbol": symbol,
                            "timestamp": timestamp,
                            "count": len(group),
                            "records": group.to_dict("records"),
                        }
                    )

            logger.error(
                "%s Found %s%s timestamp+symbol duplicates in %s%s",
                Fore.RED,
                Fore.WHITE,
                duplicate_count,
                Fore.YELLOW,
                filename,
            )
        else:
            logger.info(
                "%s No timestamp+symbol duplicates found in %s%s", Fore.GREEN, Fore.WHITE, filename
            )

    return results


def _check_full_row_duplicates(dataframe: pd.DataFrame, filename: str) -> dict[str, Any]:
    """Check for full row duplicates."""
    results = {"has_duplicates": False, "duplicate_count": 0, "total_records": len(dataframe)}

    # Check for full row duplicates
    duplicates = dataframe.duplicated(keep=False)
    duplicate_count = duplicates.sum()

    if duplicate_count > 0:
        results["has_duplicates"] = True
        results["duplicate_count"] = duplicate_count

        logger.warning(
            "%s Found %s%s full row duplicates in %s%s",
            Fore.YELLOW,
            Fore.WHITE,
            duplicate_count,
            Fore.YELLOW,
            filename,
        )
    else:
        logger.info("%s No full row duplicates found in %s%s", Fore.GREEN, Fore.WHITE, filename)

    return results


def _analyze_file(filename: str) -> dict[str, Any]:
    """Analyze a single CSV file for duplicates."""
    project_root = Path(__file__).parent.parent
    file_path = project_root / "data" / filename

    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s Analyzing file: %s%s", Fore.BLUE, Fore.WHITE, filename)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    try:
        # Load the CSV file
        dataframe = pd.read_csv(file_path)
        logger.info(
            "%s Loaded %s%s records from %s%s",
            Fore.CYAN,
            Fore.WHITE,
            len(dataframe),
            Fore.WHITE,
            filename,
        )

        # Check for timestamp+symbol duplicates (for OHLCV-like data)
        timestamp_symbol_results = _check_timestamp_symbol_duplicates(dataframe, filename)

        # Check for full row duplicates
        full_row_results = _check_full_row_duplicates(dataframe, filename)

        # Summary
        total_duplicates = (
            timestamp_symbol_results["duplicate_count"] + full_row_results["duplicate_count"]
        )

        if total_duplicates == 0:
            logger.info(
                "%s ✅ File %s%s is clean - no duplicates found", Fore.GREEN, Fore.WHITE, filename
            )
        else:
            logger.error(
                "%s ❌ File %s%s has %s%s total duplicates",
                Fore.RED,
                Fore.WHITE,
                filename,
                Fore.WHITE,
                total_duplicates,
            )

        return {
            "filename": filename,
            "total_records": len(dataframe),
            "timestamp_symbol_duplicates": timestamp_symbol_results,
            "full_row_duplicates": full_row_results,
            "total_duplicates": total_duplicates,
            "is_clean": total_duplicates == 0,
        }

    except Exception as e:
        logger.exception("%s Error analyzing file %s%s", Fore.RED, Fore.WHITE, filename)
        return {"filename": filename, "error": str(e), "is_clean": False}


def _print_duplicate_details(results: dict[str, Any]) -> None:
    """Print detailed information about duplicates found."""
    if not results.get("timestamp_symbol_duplicates", {}).get("duplicate_details"):
        return

    logger.info("%s Duplicate details:", Fore.YELLOW)
    for detail in results["timestamp_symbol_duplicates"]["duplicate_details"]:
        logger.info(
            "%s  Symbol: %s%s, Timestamp: %s%s, Count: %s%s",
            Fore.YELLOW,
            Fore.WHITE,
            detail["symbol"],
            Fore.WHITE,
            detail["timestamp"],
            Fore.WHITE,
            detail["count"],
        )


def check_all_files() -> None:
    """Check all CSV files in the data folder for duplicates."""
    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s 🔍 CSV Duplicate Checker", Fore.BLUE)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    # Get available files
    available_files = _get_available_files()
    if not available_files:
        logger.error("%s No CSV files found to analyze", Fore.RED)
        return

    logger.info("%s Found %s%s CSV files to analyze", Fore.CYAN, Fore.WHITE, len(available_files))

    # Analyze each file
    all_results = []
    clean_files = 0
    total_duplicates = 0

    for filename in available_files:
        results = _analyze_file(filename)
        all_results.append(results)

        if results.get("is_clean", False):
            clean_files += 1
        else:
            total_duplicates += results.get("total_duplicates", 0)
            _print_duplicate_details(results)

    # Summary report
    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s 📊 SUMMARY REPORT", Fore.BLUE)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    logger.info("%s Files analyzed: %s%s", Fore.CYAN, Fore.WHITE, len(available_files))
    logger.info("%s Clean files: %s%s", Fore.GREEN, Fore.WHITE, clean_files)
    logger.info(
        "%s Files with duplicates: %s%s", Fore.RED, Fore.WHITE, len(available_files) - clean_files
    )
    logger.info("%s Total duplicates found: %s%s", Fore.RED, Fore.WHITE, total_duplicates)

    if clean_files == len(available_files):
        logger.info("%s 🎉 All files are clean!", Fore.GREEN)
    else:
        logger.warning("%s ⚠️  Some files contain duplicates", Fore.YELLOW)

    logger.info("%s%s", Fore.BLUE, "=" * 60)


if __name__ == "__main__":
    check_all_files()

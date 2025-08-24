#!/usr/bin/env python3
"""
CSV Duplicate Checker

A comprehensive tool to check for duplicates in CSV database files.
Supports multiple duplicate detection strategies and provides detailed reporting.
"""

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class CSVDuplicateChecker:
    """A class to check for duplicates in CSV files."""

    def __init__(self, data_dir: str = "data") -> None:
        """
        Initialize the duplicate checker.

        Args:
            data_dir: Directory containing CSV files
        """
        self.data_dir = Path(data_dir)
        self.results: dict[str, dict] = {}

    def find_csv_files(self) -> list[Path]:
        """Find all CSV files in the data directory."""
        if not self.data_dir.exists():
            logger.error("Data directory %s does not exist", self.data_dir)
            return []

        csv_files = list(self.data_dir.glob("*.csv"))
        logger.info("Found %d CSV files in %s", len(csv_files), self.data_dir)
        return csv_files

    def load_csv_file(self, file_path: Path) -> pd.DataFrame | None:
        """Load a CSV file with error handling."""
        try:
            logger.info("Loading %s", file_path)
            dataframe = pd.read_csv(file_path)
            logger.info("Loaded %d rows from %s", len(dataframe), file_path.name)
        except Exception:
            logger.exception("Error loading %s", file_path)
            return None
        else:
            return dataframe

    def check_exact_duplicates(self, df: pd.DataFrame, file_name: str) -> dict:
        """Check for exact duplicate rows."""
        logger.info("Checking exact duplicates in %s", file_name)

        # Find duplicate rows
        duplicates = df[df.duplicated(keep=False)]
        duplicate_count = len(duplicates)

        # Get unique duplicate groups
        duplicate_groups = df[df.duplicated(keep=False)].groupby(df.columns.tolist()).size()

        return {
            "total_rows": len(df),
            "duplicate_rows": duplicate_count,
            "unique_duplicate_groups": len(duplicate_groups),
            "duplicate_percentage": (duplicate_count / len(df)) * 100 if len(df) > 0 else 0,
            "duplicate_groups": duplicate_groups.to_dict(),
            "duplicate_indices": duplicates.index.tolist(),
        }

    def check_column_duplicates(self, df: pd.DataFrame, file_name: str, columns: list[str]) -> dict:
        """Check for duplicates based on specific columns."""
        logger.info("Checking column duplicates in %s for columns: %s", file_name, columns)

        # Verify columns exist
        missing_cols = [col for col in columns if col not in df.columns]
        if missing_cols:
            logger.warning("Columns %s not found in %s", missing_cols, file_name)
            return {"error": f"Columns {missing_cols} not found"}

        # Find duplicates based on specified columns
        duplicates = df[df.duplicated(subset=columns, keep=False)]
        duplicate_count = len(duplicates)

        # Get unique duplicate groups
        duplicate_groups = df[df.duplicated(subset=columns, keep=False)].groupby(columns).size()

        return {
            "total_rows": len(df),
            "duplicate_rows": duplicate_count,
            "unique_duplicate_groups": len(duplicate_groups),
            "duplicate_percentage": (duplicate_count / len(df)) * 100 if len(df) > 0 else 0,
            "columns_checked": columns,
            "duplicate_groups": duplicate_groups.to_dict(),
            "duplicate_indices": duplicates.index.tolist(),
        }

    def check_timestamp_duplicates(self, df: pd.DataFrame, file_name: str) -> dict:
        """Check for duplicates based on timestamp and symbol (common in financial data)."""
        logger.info("Checking timestamp duplicates in %s", file_name)

        # Check if timestamp and symbol columns exist
        timestamp_cols = ["timestamp", "time", "date"]
        symbol_cols = ["symbol", "ticker", "pair"]

        timestamp_col = None
        symbol_col = None

        for col in timestamp_cols:
            if col in df.columns:
                timestamp_col = col
                break

        for col in symbol_cols:
            if col in df.columns:
                symbol_col = col
                break

        if not timestamp_col:
            logger.warning("No timestamp column found in %s", file_name)
            return {"error": "No timestamp column found"}

        # Use timestamp and symbol if available, otherwise just timestamp
        subset_cols = [timestamp_col]
        if symbol_col:
            subset_cols.append(symbol_col)

        return self.check_column_duplicates(df, file_name, subset_cols)

    def check_id_duplicates(self, df: pd.DataFrame, file_name: str) -> dict:
        """Check for duplicates based on ID columns."""
        logger.info("Checking ID duplicates in %s", file_name)

        # Look for common ID column names
        id_cols = ["id", "ID", "Id", "uuid", "UUID", "primary_key"]
        found_id_cols = [col for col in id_cols if col in df.columns]

        if not found_id_cols:
            logger.warning("No ID column found in %s", file_name)
            return {"error": "No ID column found"}

        return self.check_column_duplicates(df, file_name, found_id_cols)

    def analyze_file(self, file_path: Path) -> dict:
        """Perform comprehensive duplicate analysis on a single file."""
        file_name = file_path.name
        logger.info("Analyzing %s", file_name)

        dataframe = self.load_csv_file(file_path)
        if dataframe is None:
            return {"error": f"Could not load {file_name}"}

        results = {
            "file_name": file_name,
            "file_size_mb": file_path.stat().st_size / (1024 * 1024),
            "total_rows": len(dataframe),
            "columns": list(dataframe.columns),
            "exact_duplicates": self.check_exact_duplicates(dataframe, file_name),
            "timestamp_duplicates": self.check_timestamp_duplicates(dataframe, file_name),
            "id_duplicates": self.check_id_duplicates(dataframe, file_name),
        }

        # Add specific checks based on file type
        if "ohlcv" in file_name.lower():
            results["ohlcv_duplicates"] = self.check_column_duplicates(
                dataframe, file_name, ["timestamp", "symbol"]
            )
        elif "funding" in file_name.lower():
            results["funding_duplicates"] = self.check_column_duplicates(
                dataframe, file_name, ["timestamp", "symbol"]
            )
        elif "markets" in file_name.lower():
            results["market_duplicates"] = self.check_column_duplicates(
                dataframe, file_name, ["symbol"]
            )

        return results

    def analyze_all_files(self) -> dict:
        """Analyze all CSV files in the data directory."""
        csv_files = self.find_csv_files()
        if not csv_files:
            return {"error": "No CSV files found"}

        all_results = {}
        for file_path in csv_files:
            all_results[file_path.name] = self.analyze_file(file_path)

        self.results = all_results
        return all_results

    def _format_duplicate_line(self, prefix: str, duplicate_info: dict, label: str) -> str:
        """Format a duplicate line for the report."""
        return (
            f"   {prefix} {label}: "
            f"{duplicate_info['duplicate_rows']:,} rows "
            f"({duplicate_info['duplicate_percentage']:.2f}%)"
        )

    def _process_file_result(self, result: dict) -> tuple[bool, int]:
        """Process a single file result and return duplicate info."""
        if "error" in result:
            return False, 0

        file_has_duplicates = False
        total_duplicates = 0

        # Check exact duplicates
        exact = result.get("exact_duplicates", {})
        if "duplicate_rows" in exact and exact["duplicate_rows"] > 0:
            file_has_duplicates = True
            total_duplicates += exact["duplicate_rows"]

        # Check timestamp duplicates
        timestamp = result.get("timestamp_duplicates", {})
        if "duplicate_rows" in timestamp and timestamp["duplicate_rows"] > 0:
            file_has_duplicates = True
            total_duplicates += timestamp["duplicate_rows"]

        # Check ID duplicates
        id_dups = result.get("id_duplicates", {})
        if "duplicate_rows" in id_dups and id_dups["duplicate_rows"] > 0:
            file_has_duplicates = True
            total_duplicates += id_dups["duplicate_rows"]

        # Check specific file type duplicates
        for key, value in result.items():
            if (
                key.endswith("_duplicates")
                and key not in ["exact_duplicates", "timestamp_duplicates", "id_duplicates"]
                and "duplicate_rows" in value
                and value["duplicate_rows"] > 0
            ):
                file_has_duplicates = True
                total_duplicates += value["duplicate_rows"]

        return file_has_duplicates, total_duplicates

    def _format_file_report(self, file_name: str, result: dict) -> list[str]:
        """Format the report for a single file."""
        report_lines = []

        if "error" in result:
            report_lines.append(f"❌ {file_name}: {result['error']}")
            return report_lines

        report_lines.append(f"📊 {file_name}")
        report_lines.append(f"   Size: {result['file_size_mb']:.2f} MB")
        report_lines.append(f"   Rows: {result['total_rows']:,}")
        report_lines.append(f"   Columns: {len(result['columns'])}")

        # Check exact duplicates
        exact = result.get("exact_duplicates", {})
        if "duplicate_rows" in exact and exact["duplicate_rows"] > 0:
            report_lines.append(self._format_duplicate_line("🔴", exact, "Exact duplicates"))

        # Check timestamp duplicates
        timestamp = result.get("timestamp_duplicates", {})
        if "duplicate_rows" in timestamp and timestamp["duplicate_rows"] > 0:
            report_lines.append(
                self._format_duplicate_line("🕐", timestamp, "Timestamp duplicates")
            )

        # Check ID duplicates
        id_dups = result.get("id_duplicates", {})
        if "duplicate_rows" in id_dups and id_dups["duplicate_rows"] > 0:
            report_lines.append(self._format_duplicate_line("🆔", id_dups, "ID duplicates"))

        # Check specific file type duplicates
        for key, value in result.items():
            if (
                key.endswith("_duplicates")
                and key not in ["exact_duplicates", "timestamp_duplicates", "id_duplicates"]
                and "duplicate_rows" in value
                and value["duplicate_rows"] > 0
            ):
                label = key.replace("_duplicates", "").title()
                report_lines.append(self._format_duplicate_line("📈", value, f"{label} duplicates"))

        file_has_duplicates, _ = self._process_file_result(result)
        if not file_has_duplicates:
            report_lines.append("   ✅ No duplicates found")

        report_lines.append("")
        return report_lines

    def generate_summary_report(self) -> str:
        """Generate a summary report of all findings."""
        if not self.results:
            return "No results to report. Run analyze_all_files() first."

        report = []
        report.append("=" * 80)
        report.append("CSV DUPLICATE CHECKER - SUMMARY REPORT")
        report.append("=" * 80)
        report.append(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}")
        report.append(f"Files analyzed: {len(self.results)}")
        report.append("")

        total_duplicates = 0
        files_with_duplicates = 0

        for file_name, result in self.results.items():
            report.extend(self._format_file_report(file_name, result))
            file_has_duplicates, file_duplicates = self._process_file_result(result)
            if file_has_duplicates:
                files_with_duplicates += 1
                total_duplicates += file_duplicates

        report.append("=" * 80)
        report.append("SUMMARY STATISTICS")
        report.append("=" * 80)
        report.append(f"Total files analyzed: {len(self.results)}")
        report.append(f"Files with duplicates: {files_with_duplicates}")
        report.append(f"Total duplicate rows found: {total_duplicates:,}")
        report.append("=" * 80)

        return "\n".join(report)

    def save_detailed_report(self, output_file: str = "duplicate_report.txt") -> None:
        """Save a detailed report to a file."""
        if not self.results:
            logger.error("No results to save. Run analyze_all_files() first.")
            return

        with Path(output_file).open("w") as f:
            f.write(self.generate_summary_report())
            f.write("\n\n" + "=" * 80 + "\n")
            f.write("DETAILED RESULTS\n")
            f.write("=" * 80 + "\n\n")

            for file_name, result in self.results.items():
                f.write(f"FILE: {file_name}\n")
                f.write("-" * 40 + "\n")
                f.write("Detailed analysis:\n")
                f.write(str(result))
                f.write("\n\n")

        logger.info("Detailed report saved to %s", output_file)


def main() -> None:
    """Main function to run the duplicate checker."""
    parser = argparse.ArgumentParser(description="Check for duplicates in CSV database files")
    parser.add_argument("--data-dir", default="data", help="Directory containing CSV files")
    parser.add_argument(
        "--output", default="duplicate_report.txt", help="Output file for detailed report"
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Create and run the duplicate checker
    checker = CSVDuplicateChecker(args.data_dir)
    results = checker.analyze_all_files()

    # Print summary report
    logger.info(checker.generate_summary_report())

    # Save detailed report
    checker.save_detailed_report(args.output)

    # Return appropriate exit code
    if any("error" not in result for result in results.values()):
        files_with_duplicates = sum(
            1
            for result in results.values()
            if "error" not in result
            and any(
                key.endswith("_duplicates")
                and "duplicate_rows" in result[key]
                and result[key]["duplicate_rows"] > 0
                for key in result
            )
        )

        if files_with_duplicates > 0:
            logger.warning("Found duplicates in %d files", files_with_duplicates)
            sys.exit(1)
        else:
            logger.info("No duplicates found")
            sys.exit(0)
    else:
        logger.error("Failed to analyze any files")
        sys.exit(2)


if __name__ == "__main__":
    main()

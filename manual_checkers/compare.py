import logging
from pathlib import Path

import pandas as pd
from colorama import Fore, Style, init

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


def find_file_in_data_folder(filename: str) -> Path | None:
    """
    Find a file in the data folder from the project root.

    Args:
        filename: Name of the file to find

    Returns:
        Path to the file if found, None otherwise
    """
    # Get the project root (assuming this script is in manual_checkers/)
    project_root = Path(__file__).parent.parent
    data_folder = project_root / "data"

    # Check if data folder exists
    if not data_folder.exists():
        logger.error("%s Data folder not found at: %s", Fore.RED, data_folder)
        return None

    # Look for the file in the data folder
    file_path = data_folder / filename

    if file_path.exists():
        logger.info("%s Found file: %s", Fore.GREEN, file_path)
        return file_path
    logger.warning("%s File not found: %s", Fore.YELLOW, file_path)
    # List available files in data folder
    available_files = [f.name for f in data_folder.iterdir() if f.is_file()]
    if available_files:
        logger.info("%s Available files in data folder:", Fore.CYAN)
        for file in sorted(available_files):
            logger.info("%s  - %s", Fore.CYAN, file)
    return None


def _compare_column_names(df1: pd.DataFrame, df2: pd.DataFrame) -> tuple[bool, str]:
    """Compare column names between two DataFrames."""
    if not df1.columns.equals(df2.columns):
        logger.error("%s Files are not identical: Column names or order differ.", Fore.RED)
        logger.info("%s File 1 columns: %s%s", Fore.CYAN, Fore.WHITE, df1.columns.tolist())
        logger.info("%s File 2 columns: %s%s", Fore.CYAN, Fore.WHITE, df2.columns.tolist())
        return False, "Column names or order differ."

    logger.info("%s Column names are identical!", Fore.GREEN)
    return True, ""


def _compare_data_content(df1: pd.DataFrame, df2: pd.DataFrame) -> tuple[bool, str]:
    """Compare the actual data content between two DataFrames."""
    logger.info("%s Sorting data for comparison...", Fore.BLUE)
    df1_sorted = df1.sort_values(by=df1.columns.tolist()).reset_index(drop=True)
    df2_sorted = df2.sort_values(by=df2.columns.tolist()).reset_index(drop=True)

    logger.info("%s Comparing sorted data...", Fore.BLUE)
    if df1_sorted.equals(df2_sorted):
        logger.info("%s File contents are identical (row order was ignored).", Fore.GREEN)
        return True, ""

    logger.error("%s File contents are different.", Fore.RED)
    diff = df1_sorted.compare(df2_sorted)
    diff_str = diff.to_string()
    logger.info("%s Differences found:", Fore.YELLOW)
    logger.info("%s%s", Fore.WHITE, diff_str)
    return False, diff_str


def _load_and_validate_files(
    file1_name: str, file2_name: str
) -> tuple[pd.DataFrame | None, pd.DataFrame | None]:
    """Load and validate CSV files from the data folder."""
    file1_path = find_file_in_data_folder(file1_name)
    file2_path = find_file_in_data_folder(file2_name)

    if file1_path is None or file2_path is None:
        logger.error("%s Could not locate one or both files in data folder", Fore.RED)
        return None, None

    logger.info("%s Loading files...", Fore.GREEN)
    df1 = pd.read_csv(file1_path)
    df2 = pd.read_csv(file2_path)

    logger.info("%s File 1 shape: %s%s", Fore.CYAN, Fore.WHITE, df1.shape)
    logger.info("%s File 2 shape: %s%s", Fore.CYAN, Fore.WHITE, df2.shape)

    return df1, df2


def compare_csv_content(file1_name: str, file2_name: str) -> tuple[bool, str]:
    """
    Compares the content of two CSV files, ignoring row order.
    Files are considered identical if they have the same columns
    and the same set of data (regardless of their order).

    Args:
        file1_name: Name of the first file (will be searched in data folder)
        file2_name: Name of the second file (will be searched in data folder)

    Returns:
        Tuple of (identical: bool, diff_str: str)
    """
    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info(
        "%s Comparing files: %s%s %svs %s%s",
        Fore.BLUE,
        Fore.WHITE,
        file1_name,
        Fore.BLUE,
        Fore.WHITE,
        file2_name,
    )
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    identical = False
    diff_str = ""

    try:
        # Load and validate files
        df1, df2 = _load_and_validate_files(file1_name, file2_name)
        if df1 is None or df2 is None:
            return False, "One or both files not found in data folder"

        # Compare column names
        logger.info("%s Comparing column names...", Fore.BLUE)
        columns_match, column_diff = _compare_column_names(df1, df2)
        if not columns_match:
            diff_str = column_diff
        else:
            # Compare data content
            identical, diff_str = _compare_data_content(df1, df2)

    except FileNotFoundError:
        logger.exception("%s One or both files not found.", Fore.RED)
        diff_str = "One or both files not found."
    except pd.errors.EmptyDataError:
        logger.exception("%s One or both files are empty.", Fore.RED)
        diff_str = "One or both files are empty."
    except pd.errors.ParserError:
        logger.exception("%s An error occurred while parsing CSV files", Fore.RED)
        diff_str = "An error occurred while parsing CSV files"
    except Exception:
        logger.exception("%s An unexpected error occurred", Fore.RED)
        diff_str = "An unexpected error occurred"

    logger.info("%s%s", Fore.BLUE, "=" * 60)
    if identical:
        logger.info("%s Comparison completed: Files are IDENTICAL!", Fore.GREEN)
    else:
        logger.info("%s Comparison completed: Files are DIFFERENT!", Fore.RED)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    return identical, diff_str


def _get_available_files() -> list[str]:
    """Get list of available CSV files in the data folder."""
    project_root = Path(__file__).parent.parent
    data_folder = project_root / "data"

    if not data_folder.exists():
        logger.error("%s Data folder not found at: %s", Fore.RED, data_folder)
        return []

    csv_files = [f.name for f in data_folder.iterdir() if f.is_file() and f.name.endswith(".csv")]
    return sorted(csv_files)


def _select_file_from_list(available_files: list[str], prompt: str) -> str | None:
    """Let user select a file from the available files list."""
    if not available_files:
        logger.error("%s No CSV files found in data folder", Fore.RED)
        return None

    logger.info("%s %s:", Fore.CYAN, prompt)
    for i, filename in enumerate(available_files, 1):
        logger.info("%s) %s", i, filename)

    while True:
        selection = input(f"{Fore.WHITE}Selection (1-{len(available_files)}): ").strip()

        if selection.isdigit():
            index = int(selection) - 1
            if 0 <= index < len(available_files):
                return available_files[index]

        logger.error("%s Invalid selection! Please choose 1-%s", Fore.RED, len(available_files))


def main() -> None:
    """Main function to run the comparison utility."""
    logger.info("%s%s", Fore.BLUE, "=" * 60)
    logger.info("%s CSV File Comparison Utility", Fore.BLUE)
    logger.info("%s%s", Fore.BLUE, "=" * 60)

    # Get available files
    available_files = _get_available_files()
    if not available_files:
        return

    # Let user select files
    file1 = _select_file_from_list(available_files, "Select first file to compare")
    if file1 is None:
        return

    file2 = _select_file_from_list(available_files, "Select second file to compare")
    if file2 is None:
        return

    # Run comparison
    compare_csv_content(file1, file2)


if __name__ == "__main__":
    main()

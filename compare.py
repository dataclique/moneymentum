import logging

import pandas as pd

# Configure logging
logger = logging.getLogger(__name__)


def compare_csv_content(file1_path: str, file2_path: str) -> bool:
    """
    Compares the content of two CSV files, ignoring row order.
    Files are considered identical if they have the same columns
    and the same set of data (regardless of their order).
    """
    identical = False
    try:
        df1 = pd.read_csv(file1_path)
        df2 = pd.read_csv(file2_path)

        # 1. Compare headers (column names)
        if not df1.columns.equals(df2.columns):
            logger.info("Files are not identical: Column names or order differ.")
            logger.info("File 1 columns: %s", df1.columns.tolist())
            logger.info("File 2 columns: %s", df2.columns.tolist())
        else:
            # 2. Sort data
            df1_sorted = df1.sort_values(by=df1.columns.tolist()).reset_index(drop=True)
            df2_sorted = df2.sort_values(by=df2.columns.tolist()).reset_index(drop=True)

            # 3. Compare sorted DataFrames
            if df1_sorted.equals(df2_sorted):
                logger.info("File contents are identical (row order was ignored).")
                identical = True
            else:
                logger.info("File contents are different.")

    except FileNotFoundError:
        logger.exception("One or both files not found.")
    except pd.errors.EmptyDataError:
        logger.exception("One or both files are empty.")
    except pd.errors.ParserError:
        logger.exception("An error occurred while parsing CSV files")
    except Exception:  # Catching a more general Exception as a fallback, but logging it.
        logger.exception("An unexpected error occurred")

    return identical


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    logger.info("--- analysis_df_1h,  analysis_df_1h_optimized ---")
    compare_csv_content("analysis_df_1h.csv", "analysis_df_1h_optimized.csv")  # Expected False

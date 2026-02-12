from __future__ import annotations

import logging
import sys
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

EXPECTED_ARGS = 3


def find_row_differences(a: Path, b: Path) -> None:
    """
    Find rows that exist only in A or only in B.

    Comparison is done on all common columns (exact match).
    Full differences are written to diff_only_in_a.csv / diff_only_in_b.csv.
    """
    df_a = pd.read_csv(a)
    df_b = pd.read_csv(b)

    if list(df_a.columns) != list(df_b.columns):
        logger.warning("Different columns/order; comparing on intersection.")
        common_cols = [c for c in df_a.columns if c in df_b.columns]
        df_a = df_a[common_cols]
        df_b = df_b[common_cols]
    else:
        common_cols = list(df_a.columns)

    merged = df_a.merge(
        df_b,
        how="outer",
        on=common_cols,
        indicator=True,
    )

    only_a = merged[merged["_merge"] == "left_only"].drop(columns="_merge")
    only_b = merged[merged["_merge"] == "right_only"].drop(columns="_merge")

    logger.info("Rows only in A: %d", len(only_a))
    logger.info("Rows only in B: %d", len(only_b))

    if not only_a.empty:
        logger.info("First 5 rows only in A:\n%s", only_a.head())

    if not only_b.empty:
        logger.info("First 5 rows only in B:\n%s", only_b.head())

    only_a.to_csv("diff_only_in_a.csv", index=False)
    only_b.to_csv("diff_only_in_b.csv", index=False)
    logger.info("Saved full diffs to diff_only_in_a.csv and diff_only_in_b.csv")


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if len(argv) != EXPECTED_ARGS:
        logger.error("Usage: python diff_csv_rows.py path/to/a.csv path/to/b.csv")
        return 1

    a = Path(argv[1])
    b = Path(argv[2])
    find_row_differences(a, b)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

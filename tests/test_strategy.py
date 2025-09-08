import pytest
import pandas as pd
from pyspark.sql import SparkSession
from pipeline import SchemaOHLCV
from yang.strat import Strategy
from yang.util import TIMEFRAME_CONFIGS
from backtest import BacktestPipeline


@pytest.fixture(scope="module")
def spark_session():
    """Fixture to initialize a Spark session."""
    spark = SparkSession.builder.appName("TestStrategy").getOrCreate()
    yield spark
    spark.stop()


def _compare_pandas_dfs(df1: pd.DataFrame, df2: pd.DataFrame) -> tuple[bool, str]:
    """
    Compares two pandas DataFrames for equality, ignoring row order.
    Returns a tuple of (bool, str) where bool is True if they are
    identical, and str contains differences if they are not.
    """
    if not df1.columns.equals(df2.columns):
        return False, "Column names or order differ."

    # Sort by all columns to ensure order-independent comparison
    df1_sorted = df1.sort_values(by=df1.columns.tolist()).reset_index(drop=True)
    df2_sorted = df2.sort_values(by=df2.columns.tolist()).reset_index(drop=True)

    if df1_sorted.equals(df2_sorted):
        return True, ""

    # If not equal, find and return the differences
    diff = df1_sorted.compare(df2_sorted)
    return False, diff.to_string()


def test_compare_analysis_implementations(spark_session):
    """
    Test that generate_analysis and generate_analysis_optimized
    produce the same results.
    """
    timeframe = "1h"
    config = TIMEFRAME_CONFIGS[timeframe]
    strategy = Strategy(
        timeframe=timeframe,
        config=config,
        leverage=1.0,
        starting_equity=10000.0,
        min_position_size=100.0,
    )

    candles_df = (
        spark_session.read.schema(SchemaOHLCV).csv("./test_data/ohlcv1h.csv", header=True).cache()
    )

    analysis_df = strategy.generate_analysis(candles_df)
    analysis_optimized_df = strategy.generate_analysis_optimized(candles_df)

    analysis_df = analysis_df.select(BacktestPipeline._COLUMNS_ORDER)
    analysis_optimized_df = analysis_optimized_df.select(BacktestPipeline._COLUMNS_ORDER)

    # Convert Spark DataFrames to pandas DataFrames for comparison
    analysis_pd = analysis_df.toPandas()
    analysis_optimized_pd = analysis_optimized_df.toPandas()

    are_identical, diff = _compare_pandas_dfs(analysis_pd, analysis_optimized_pd)

    if not are_identical:
        print(f"Differences found:\n{diff}")

    assert are_identical, "Optimized and non-optimized analysis outputs are not identical"

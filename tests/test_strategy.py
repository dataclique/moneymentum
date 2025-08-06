import os
import pytest
from pyspark.sql import SparkSession
from pipeline import SchemaOHLCV
from yang.strat import Strategy
from yang.util import TIMEFRAME_CONFIGS, save_csv
from compare import compare_csv_content
from backtest import BacktestPipeline


@pytest.fixture(scope="module")
def spark_session():
    """Fixture to initialize a Spark session."""
    spark = SparkSession.builder.appName("TestStrategy").getOrCreate()
    yield spark
    spark.stop()


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
    save_csv("analysis", analysis_df)

    analysis_optimized_df = analysis_optimized_df.select(BacktestPipeline._COLUMNS_ORDER)
    save_csv("analysis_optimized", analysis_optimized_df)

    path1 = "data/analysis.csv"
    path2 = "data/analysis_optimized.csv"

    try:
        are_identical, diff = compare_csv_content(path1, path2)

        if not are_identical:
            print(f"Differences found:\n{diff}")

        assert are_identical, "Optimized and non-optimized analysis outputs are not identical"
    finally:
        # Cleanup files
        if os.path.exists(path1):
            os.remove(path1)
        if os.path.exists(path2):
            os.remove(path2)

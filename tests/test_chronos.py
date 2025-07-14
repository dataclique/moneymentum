import pytest
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

# Assuming Chronos, SchemaOHLCV, and the logger are imported or defined elsewhere
from pipeline import SchemaOHLCV, logger
from yang.chronos import Chronos
from yang.util import TIMEFRAME_CONFIGS


@pytest.fixture(scope="module")
def spark_session():
    """Fixture to initialize a Spark session."""
    spark = SparkSession.builder.appName("TestPipeline").getOrCreate()
    yield spark
    spark.stop()


def test_aave_last_record(spark_session):
    logger.info("Testing AAVE last record...")

    path = "./test_data/ohlcv1d.csv"
    candles_df = spark_session.read.schema(SchemaOHLCV).csv(path, header=True).cache()

    timeframe = "1d"
    config = TIMEFRAME_CONFIGS[timeframe]

    # lookback_periods = 370, because we have 370 records
    # and we need window size equal to amount of all records
    # risk_free = 4.5% as in United States Fed Funds Interest Rate
    chronos = Chronos(timeframe=timeframe, lookback_periods=369)
    analysis_df = (
        candles_df.transform(chronos.with_returns)
        .transform(lambda df: chronos.with_volatility(df, config))
        .transform(chronos.with_sma)
        .transform(chronos.with_zscore)
        .transform(chronos.with_beta)
        .transform(chronos.with_information_discreteness)
        .transform(lambda df: chronos.with_sharpe(df, config, risk_free=4.5 / 100))
        .transform(lambda df: chronos.with_sortino(df, config))
    )

    aave_last_record = (
        analysis_df.filter(F.col("symbol") == "AAVE/USDC")
        .orderBy(F.col("timestamp").desc())
        .limit(1)
        .collect()[0]
    )
    # Google sheet: 0.29%
    assert aave_last_record["mean_return"] == 0.0029290822331748565, "Mean return mismatch"
    # Google sheet: 0.05
    assert aave_last_record["return_stddev"] == 0.05116662705011916, "Return stddev mismatch"
    # Google sheet: 97.76%
    assert aave_last_record["annualized_volatility"] == 0.9775370372243625, (
        "Annualized volatility mismatch"
    )
    # Google sheet: 0.29
    assert aave_last_record["beta"] == 0.29206334291840363, "Beta mismatch"
    # Google sheet: 7.67E-04
    assert aave_last_record["covariance"] == 7.646287605794159e-4, "Covariance mismatch"
    # Google sheet: 1.91
    assert aave_last_record["sharpe"] == 1.9107210298591863, "Sharpe mismatch"
    # Google sheet: 58.55559538
    assert aave_last_record["sortino"] == 58.47787278854239, "Sortino mismatch"

    logger.info("AAVE last record assertions passed.")


def test_btc_last_record(spark_session):
    logger.info("Testing BTC last record...")

    path = "./test_data/ohlcv1d.csv"
    candles_df = spark_session.read.schema(SchemaOHLCV).csv(path, header=True).cache()

    timeframe = "1d"
    config = TIMEFRAME_CONFIGS[timeframe]

    # lookback_periods = 370, because we have 370 records
    # and we need window size equal to amount of all records
    # risk_free = 4.5% as in United States Fed Funds Interest Rate
    chronos = Chronos(timeframe=timeframe, lookback_periods=369)
    analysis_df = (
        candles_df.transform(chronos.with_returns)
        .transform(lambda df: chronos.with_volatility(df, config))
        .transform(chronos.with_sma)
        .transform(chronos.with_zscore)
        .transform(chronos.with_beta)
        .transform(chronos.with_information_discreteness)
        .transform(lambda df: chronos.with_sharpe(df, config, risk_free=4.5 / 100))
        .transform(lambda df: chronos.with_sortino(df, config))
    )

    btc_last_record = (
        analysis_df.filter(F.col("symbol") == "BTC/USDC")
        .orderBy(F.col("timestamp").desc())
        .limit(1)
        .collect()[0]
    )

    # Google sheet: 0.22%
    assert btc_last_record["mean_return"] == 0.002159416213018761, "Mean return mismatch"
    # Google sheet: 0.03
    assert btc_last_record["return_stddev"] == 0.027437960505078306, "Return stddev mismatch"
    # Google sheet: 52.42%
    assert btc_last_record["annualized_volatility"] == 0.5242014994136859, (
        "Annualized volatility mismatch"
    )
    # Google sheet: 1.00
    assert btc_last_record["beta"] == 0.9972899728997291, "Beta mismatch"
    # Google sheet: 7.53E-04
    assert btc_last_record["covariance"] == 7.508014553322255e-4, "Covariance mismatch"
    # Google sheet: 2.20
    assert btc_last_record["sharpe"] == 2.2022163385448854, "Sharpe mismatch"
    # Google sheet: 67.69
    assert btc_last_record["sortino"] == 67.61912314735203, "Sortino mismatch"

    logger.info("BTC last record assertions passed.")


def test_ai_last_record(spark_session):
    logger.info("Testing AI last record...")

    path = "./test_data/ohlcv1w.csv"
    candles_df = spark_session.read.schema(SchemaOHLCV).csv(path, header=True).cache()

    timeframe = "1w"
    config = TIMEFRAME_CONFIGS[timeframe]

    # lookback_periods = 52, because we have 52 records
    # and we need window size equal to amount of all records
    # risk_free = 4.5% as in United States Fed Funds Interest Rate
    chronos = Chronos(timeframe=timeframe, lookback_periods=51)
    analysis_df = (
        candles_df.transform(chronos.with_returns)
        .transform(lambda df: chronos.with_volatility(df, config))
        .transform(chronos.with_sma)
        .transform(chronos.with_zscore)
        .transform(chronos.with_beta)
        .transform(chronos.with_information_discreteness)
        .transform(lambda df: chronos.with_sharpe(df, config, risk_free=4.5 / 100))
        .transform(lambda df: chronos.with_sortino(df, config))
    )

    ai_last_record = (
        analysis_df.filter(F.col("symbol") == "AI/USDC")
        .orderBy(F.col("timestamp").desc())
        .limit(1)
        .collect()[0]
    )

    # Google sheet: -1.27%
    assert ai_last_record["mean_return"] == -0.012734350383113274, "Mean return mismatch"
    # Google sheet: 0.16
    assert ai_last_record["return_stddev"] == 0.16124563962681307, "Return stddev mismatch"
    # Google sheet: 116.28%
    assert ai_last_record["annualized_volatility"] == 1.1627588432389253, (
        "Annualized volatility mismatch"
    )
    # Google sheet: 0.28
    assert ai_last_record["beta"] == 0.27410619693561644, "Beta mismatch"
    # Google sheet: 7.27E-03
    assert ai_last_record["covariance"] == 0.007126803962757325, "Covariance mismatch"
    # Google sheet: -0.46
    assert ai_last_record["sharpe"] == -0.4551910183347762, "Sharpe mismatch"
    # Google sheet: -3.89
    assert ai_last_record["sortino"] == -3.864954992414675, "Sortino mismatch"

    logger.info("AI last record assertions passed.")

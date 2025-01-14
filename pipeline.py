import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql import types as T

from yang import util
from yang.chronos import Chronos
from yang.dataloader.hyperliquid import normalize_timestamp
from yang.dataloader.hyperliquid.markets import HyperliquidDataLoaderMarkets, SchemaPerpMarket
from yang.dataloader.hyperliquid.ohlcv import HyperliquidDataLoaderOHLCV

if __name__ == "__main__":
    util.setup_logging()

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)

SchemaOHLCV = T.StructType(
    [
        T.StructField("timestamp", T.TimestampType()),
        T.StructField("open", T.DoubleType()),
        T.StructField("high", T.DoubleType()),
        T.StructField("low", T.DoubleType()),
        T.StructField("close", T.DoubleType()),
        T.StructField("volume", T.DoubleType()),
        T.StructField("symbol", T.StringType()),
        T.StructField("ticker", T.StringType()),
    ]
)

Timeframe = Literal["1h", "1d", "1w"]


@F.udf(returnType=T.FloatType())
def long_score(  # noqa: PLR0913
    # ticker: str,
    close: float,
    min_price: float,
    max_price: float,
    mean_return: float,
    return_stddev: float,
    beta: float,
    price_zscore: float,
    timeframe: Timeframe,
) -> float:
    drawdown_factor = -((close / max_price) - 1)
    ranup_factor = (close / min_price) - 1
    range_factor = drawdown_factor / ranup_factor

    if timeframe == "1h":
        annualized_return = mean_return * 365 * 24
        annualized_volatility = return_stddev * np.sqrt(365 * 24)
    elif timeframe == "1d":
        annualized_return = mean_return * 365
        annualized_volatility = return_stddev * np.sqrt(365)
    elif timeframe == "1w":
        annualized_return = mean_return * 52
        annualized_volatility = return_stddev * np.sqrt(52)

    risk_free_rate = 0.045
    risk_adjusted_return_factor = (annualized_return - risk_free_rate) / (
        annualized_volatility * beta
    )

    mean_reversion_factor = np.exp(-price_zscore * 0.01)
    return float(range_factor * risk_adjusted_return_factor * mean_reversion_factor)


@F.udf(returnType=T.FloatType())
def short_score(  # noqa: PLR0913
    # ticker: str,
    close: float,
    min_price: float,
    max_price: float,
    mean_return: float,
    return_stddev: float,
    beta: float,
    price_zscore: float,
    timeframe: Timeframe,
) -> float:
    smoked_factor = (close / min_price) - 1
    ranup_factor = 1 - (close / max_price)
    range_factor = smoked_factor / ranup_factor

    if timeframe == "1h":
        annualized_return = mean_return * 365 * 24
        annualized_volatility = return_stddev * np.sqrt(365 * 24)
    elif timeframe == "1d":
        annualized_return = mean_return * 365
        annualized_volatility = return_stddev * np.sqrt(365)
    elif timeframe == "1w":
        annualized_return = mean_return * 52
        annualized_volatility = return_stddev * np.sqrt(52)

    risk_free_rate = 0.045
    risk_adjusted_return_factor = (-annualized_return - risk_free_rate) / (
        annualized_volatility * beta
    )

    mean_reversion_factor = np.exp(price_zscore * 0.01)
    return float(range_factor * risk_adjusted_return_factor * mean_reversion_factor)


@dataclass
class Pipeline:
    spark = util.get_spark()
    loader_markets = HyperliquidDataLoaderMarkets(spark=spark)
    loader_ohlcv = HyperliquidDataLoaderOHLCV()

    timeframe: Timeframe = "1h"

    async def get_candles_df(self, timeframe: Timeframe) -> DataFrame:
        start_date: datetime = datetime(2024, 6, 1, tzinfo=timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )

        logger.debug("Initializing exchange...")
        exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        logger.info("Exchange initialized: %s", exchange)

        # Only last 5000 candles available
        logger.info("Fetching data since: %s", start_date)
        since = int(start_date.timestamp() * 1000)

        reload_markets = True
        if reload_markets:
            markets_df = await self.loader_markets.fetch_markets(exchange=exchange)
        else:
            markets_path = f"{util.DATA_DIR}/markets.csv"
            markets_df = (
                self.spark.read.schema(SchemaPerpMarket).csv(markets_path, header=True).cache()
            )

        symbols = markets_df.select("symbol").rdd.flatMap(lambda x: x).collect()

        # Fetch OHLCV data concurrently
        ohlcv_tasks = [
            self.loader_ohlcv.fetch_ohlcv(exchange, symbol, timeframe, since) for symbol in symbols
        ]

        # funding_rate_tasks = [
        #     self.fetch_funding_rate_history(exchange, symbol, since) for symbol in symbols
        # ]

        # ohlcv_results, funding_rate_results = await asyncio.gather(
        #     asyncio.gather(*ohlcv_tasks), asyncio.gather(*funding_rate_tasks)
        # )

        ohlcv_results = await asyncio.gather(*ohlcv_tasks)

        # Flatten results
        ohlcv_data = [candle for candles in ohlcv_results for candle in candles]
        # funding_rate_data = [rate for rates in funding_rate_results for rate in rates]

        # Normalize timestamps
        # for rate in funding_rate_data:
        #     rate["timestamp"] = normalize_timestamp(rate["timestamp"])
        for candle in ohlcv_data:
            candle["timestamp"] = normalize_timestamp(candle["timestamp"])

        # Create funding rate lookup map
        # funding_rate_map = {
        #     (rate["symbol"], rate["timestamp"]): rate["funding_rate"] for rate in funding_rate_data  # noqa: E501
        # }

        # Add funding rate to OHLCV data
        # for candle in ohlcv_data:
        #     candle["funding_rate"] = funding_rate_map.get(
        #         (candle["symbol"], candle["timestamp"]), None
        #     )

        # Update schema to include funding_rate
        # schema = T.StructType(
        #     SchemaOHLCV.fields + [T.StructField("funding_rate", T.DoubleType(), nullable=True)]
        # )

        # Convert to Spark DataFrame
        pdf = pd.DataFrame(ohlcv_data)
        ohlcv_df = self.spark.createDataFrame(pdf, schema=SchemaOHLCV)
        logger.info("Converted to Spark DataFrame: %s", ohlcv_df.printSchema())

        # Save and return
        candles_df = ohlcv_df.orderBy("timestamp")
        candles_file_name = f"ohlcv{timeframe}"
        util.save_csv(candles_file_name, candles_df)

        candles_path = f"{util.DATA_DIR}/{candles_file_name}.csv"
        return self.spark.read.schema(SchemaOHLCV).csv(candles_path, header=True).cache()

    async def run(self) -> None:
        logger.info("Starting pipeline...")

        chronos = Chronos(timeframe=self.timeframe, lookback_periods=24 * 3)

        reload = False
        path = f"{util.DATA_DIR}/ohlcv{self.timeframe}.csv"
        if reload or not Path(path).exists():
            candles_df = await self.get_candles_df(timeframe=self.timeframe)
        else:
            candles_df = self.spark.read.schema(SchemaOHLCV).csv(path, header=True).cache()

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        analysis_df = (
            candles_df.transform(chronos.with_returns)
            .transform(chronos.with_volatility)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .transform(chronos.with_information_discreteness)
            .drop("count", "symbol", "open", "high", "low", "mean_return")
        )

        # Get latest entries
        latest = candles_df.select(F.max("timestamp")).first()[0]
        logger.info("Latest timestamp: %s", latest)
        latest_df = analysis_df.filter(F.col("timestamp") == F.lit(latest)).dropna().cache()

        latest_df.show(vertical=True)
        latest_df.count()

        picks = latest_df.orderBy("price_zscore", ascending=True)
        util.save_csv("picks", picks)

    async def test(self) -> None:
        logger.info("Starting testing pipeline...")

        # lookback_periods = 370, because we have 370 records
        # and we need window size equal to amount of all records
        chronos = Chronos(timeframe="1d", lookback_periods=370)

        path = "./test_data/ohlcv1d.csv"
        candles_df = self.spark.read.schema(SchemaOHLCV).csv(path, header=True).cache()

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        analysis_df = (
            candles_df.transform(chronos.with_returns)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_volatility)
            .transform(chronos.with_beta)
            .transform(chronos.with_information_discreteness)
        )

        aave_last_record = (
            analysis_df.filter(F.col("symbol") == "AAVE/USDC")
            .orderBy(F.col("timestamp").desc())
            .limit(1)
            .collect()[0]
        )

        btc_last_record = (
            analysis_df.filter(F.col("symbol") == "BTC/USDC")
            .orderBy(F.col("timestamp").desc())
            .limit(1)
            .collect()[0]
        )

        actual_mean_return_aave = aave_last_record["mean_return"]
        actual_return_stddev_aave = aave_last_record["return_stddev"]
        actual_annualized_volatility_aave = aave_last_record["annualized_volatility"]
        actual_beta_aave = aave_last_record["beta"]
        actual_covariance_aave = aave_last_record["covariance"]

        # Google sheet: 0.29%
        expected_mean_return_aave = 0.0029290822331748565
        # Google sheet: 0.05
        expected_return_stddev_aave = 0.05116662705011916
        # Google sheet: 97.76%
        expected_annualized_volatility_aave = 0.9775370372243625
        # Google sheet: 0.29
        expected_beta_aave = 0.29206334291840363
        # Google sheet: 7.67E-04
        expected_covariance_aave = 7.646287605794159e-4

        assert (
            actual_mean_return_aave == expected_mean_return_aave
        ), f"Mean return mismatch: {actual_mean_return_aave} != {expected_mean_return_aave}"
        assert (
            actual_return_stddev_aave == expected_return_stddev_aave
        ), f"Return stddev mismatch: {actual_return_stddev_aave} != {expected_return_stddev_aave}"
        assert (
            actual_annualized_volatility_aave == expected_annualized_volatility_aave
        ), f"Annualized volatility mismatch: {actual_annualized_volatility_aave} != {expected_annualized_volatility_aave}"
        assert (
            actual_beta_aave == expected_beta_aave
        ), f"Beta mismatch: {actual_beta_aave} != {expected_beta_aave}"
        assert (
            actual_covariance_aave == expected_covariance_aave
        ), f"Covariance mismatch: {actual_covariance_aave} != {expected_covariance_aave}"

        logger.info("All assertions passed for the last record of AAVE.")

        actual_mean_return_btc = btc_last_record["mean_return"]
        actual_return_stddev_btc = btc_last_record["return_stddev"]
        actual_annualized_volatility_btc = btc_last_record["annualized_volatility"]
        actual_beta_btc = btc_last_record["beta"]
        actual_covariance_btc = btc_last_record["covariance"]

        # Google sheet: 0.22%
        expected_mean_return_btc = 0.002159416213018761
        # Google sheet: 0.03
        expected_return_stddev_btc = 0.027437960505078306
        # Google sheet: 52.42%
        expected_annualized_volatility_btc = 0.5242014994136859
        # Google sheet: 1.00
        expected_beta_btc = 0.9972899728997291
        # Google sheet: 7.53E-04
        expected_covariance_btc = 7.508014553322255e-4

        assert (
            actual_mean_return_btc == expected_mean_return_btc
        ), f"Mean return mismatch: {actual_mean_return_btc} != {expected_mean_return_btc}"
        assert (
            actual_return_stddev_btc == expected_return_stddev_btc
        ), f"Return stddev mismatch: {actual_return_stddev_btc} != {expected_return_stddev_btc}"
        assert (
            actual_annualized_volatility_btc == expected_annualized_volatility_btc
        ), f"Annualized volatility mismatch: {actual_annualized_volatility_btc} != {expected_annualized_volatility_btc}"
        assert (
            actual_beta_btc == expected_beta_btc
        ), f"Beta mismatch: {actual_beta_btc} != {expected_beta_btc}"
        assert (
            actual_covariance_btc == expected_covariance_btc
        ), f"Covariance mismatch: {actual_covariance_btc} != {expected_covariance_btc}"

        logger.info("All assertions passed for the last record of BTC.")

        # lookback_periods = 52, because we have 52 records
        # and we need window size equal to amount of all records
        chronos2 = Chronos(timeframe="1w", lookback_periods=52)
        path2 = "./test_data/ohlcv1w.csv"
        candles_df2 = self.spark.read.schema(SchemaOHLCV).csv(path2, header=True).cache()

        analysis_df2 = (
            candles_df2.transform(chronos2.with_returns)
            .transform(chronos2.with_sma)
            .transform(chronos2.with_zscore)
            .transform(chronos2.with_volatility)
            .transform(chronos2.with_beta)
            .transform(chronos2.with_information_discreteness)
        )

        ai_last_record = (
            analysis_df2.filter(F.col("symbol") == "AI/USDC")
            .orderBy(F.col("timestamp").desc())
            .limit(1)
            .collect()[0]
        )

        actual_mean_return_ai = ai_last_record["mean_return"]
        actual_return_stddev_ai = ai_last_record["return_stddev"]
        actual_annualized_volatility_ai = ai_last_record["annualized_volatility"]
        actual_beta_ai = ai_last_record["beta"]
        actual_covariance_ai = ai_last_record["covariance"]

        # Google sheet: -1.27%
        expected_mean_return_ai = -0.012734350383113274
        # Google sheet: 0.16
        expected_return_stddev_ai = 0.16124563962681307
        # Google sheet: 116.28%
        expected_annualized_volatility_ai = 1.1627588432389253
        # Google sheet: 0.28
        expected_beta_ai = 0.27410619693561644
        # Google sheet: 7.27E-03
        expected_covariance_ai = 0.007126803962757325

        assert (
            actual_mean_return_ai == expected_mean_return_ai
        ), f"Mean return mismatch: {actual_mean_return_ai} != {expected_mean_return_ai}"
        assert (
            actual_return_stddev_ai == expected_return_stddev_ai
        ), f"Return stddev mismatch: {actual_return_stddev_ai} != {expected_return_stddev_ai}"
        assert (
            actual_annualized_volatility_ai == expected_annualized_volatility_ai
        ), f"Annualized volatility mismatch: {actual_annualized_volatility_ai} != {expected_annualized_volatility_ai}"
        assert (
            actual_beta_ai == expected_beta_ai
        ), f"Beta mismatch: {actual_beta_ai} != {expected_beta_ai}"
        assert (
            actual_covariance_ai == expected_covariance_ai
        ), f"Covariance mismatch: {actual_covariance_ai} != {expected_covariance_ai}"

        logger.info("All assertions passed for the last record of AI.")


if __name__ == "__main__":
    pipeline = Pipeline()

    asyncio.run(pipeline.test())

    # asyncio.run(pipeline.run())

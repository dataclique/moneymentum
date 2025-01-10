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

        reload = True
        path = f"{util.DATA_DIR}/ohlcv{self.timeframe}.csv"
        if reload or not Path(path).exists():
            candles_df = await self.get_candles_df(timeframe=self.timeframe)
        else:
            candles_df = self.spark.read.schema(SchemaOHLCV).csv(path, header=True).cache()

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        analysis_df = (
            candles_df.transform(chronos.with_returns)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            # .transform(chronos.with_volatility)
            # .transform(chronos.with_beta)
            # .transform(chronos.with_information_discreteness)
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


if __name__ == "__main__":
    pipeline = Pipeline()
    asyncio.run(pipeline.run())

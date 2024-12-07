import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import colorlog
import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W

SchemaOHLCV = T.StructType(
    [
        T.StructField("timestamp", T.TimestampType()),
        T.StructField("open", T.DoubleType()),
        T.StructField("high", T.DoubleType()),
        T.StructField("low", T.DoubleType()),
        T.StructField("close", T.DoubleType()),
        T.StructField("volume", T.DoubleType()),
    ]
)


class Pipeline:
    def __init__(self, days: int = 30, log_level: int = logging.DEBUG) -> None:
        self.days = days
        self.logger = self._setup_logging(log_level)
        self.spark = self._get_spark()
        self.ohlcv_dir = "data/hyperliquid/ohlcv"

    def _setup_logging(self, log_level: int) -> logging.Logger:
        # Console handler provides colored logs to the terminal
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(
            colorlog.ColoredFormatter(
                fmt="%(log_color)s%(levelname)s:%(name)s: %(reset)s%(message)s\n",
                log_colors={
                    "DEBUG": "blue",
                    "INFO": "green",
                    "WARNING": "yellow",
                    "ERROR": "red",
                    "CRITICAL": "red,bg_white",
                },
            ),
        )

        # File handler saves all logs to a file
        logging.basicConfig(
            level=logging.ERROR,
            format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
            handlers=[
                console_handler,
                logging.FileHandler("pipeline.log"),
            ],
        )

        logger = logging.getLogger(__name__)
        logger.setLevel(log_level)
        return logger

    def _get_spark(self) -> SparkSession:
        self.logger.debug("Creating Spark session...")
        spark = SparkSession.builder.appName("pipeline").getOrCreate()
        spark.sparkContext.setLogLevel("ERROR")
        self.logger.debug("Spark session created.")
        return spark

    async def fetch_ohlcv(
        self,
        exchange: ccxt.Exchange,
        symbol: str,
        timeframe: str,
        since: int,
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV data for a single symbol asynchronously."""
        try:
            self.logger.debug("Fetching data for %s...", symbol)
            ohlcv = await exchange.fetch_ohlcv(symbol, timeframe, since=since)
            self.logger.info("Fetched %s candles for %s", len(ohlcv), symbol)

            return [
                {
                    "timestamp": datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc),
                    "open": candle[1],
                    "high": candle[2],
                    "low": candle[3],
                    "close": candle[4],
                    "volume": candle[5],
                    "symbol": symbol.replace("/", "_").replace(":", "_").replace("_USDC", ""),
                }
                for candle in ohlcv
            ]
        except (ccxt.NetworkError, ccxt.ExchangeError):
            self.logger.exception("Error fetching data for %s", symbol)
        return []

    async def fetch_all_candles(
        self, exchange: ccxt.Exchange, symbols: list[str], timeframe: str, since: int
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV data for all symbols concurrently."""
        tasks = [self.fetch_ohlcv(exchange, symbol, timeframe, since) for symbol in symbols]
        results = await asyncio.gather(*tasks)
        return [candle for candles in results for candle in candles]  # Flatten results

    async def get_candles_df(self, spark: SparkSession | None = None) -> DataFrame:
        if spark is None:
            spark = self.get_spark()

        self.logger.debug("Initializing exchange...")
        exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        self.logger.info("Exchange initialized: %s", exchange)

        timeframe = "1h"
        start_date = datetime.now(timezone.utc) - timedelta(days=self.days)
        self.logger.info("Fetching data since: %s", start_date)
        since = int(start_date.timestamp() * 1000)

        # Get all perpetual pairs
        markets = await exchange.load_markets()
        symbols = list(markets.keys())
        perp_symbols = [s for s in symbols if "PERP" in s or markets[s].get("type") == "swap"]
        self.logger.info("Found %s perpetual symbols", len(perp_symbols))

        # Fetch all candles concurrently
        all_candles = await self.fetch_all_candles(exchange, perp_symbols, timeframe, since)
        self.logger.info("Fetched %s candles", len(all_candles))

        # Convert to pandas then to spark DataFrame
        pdf = pd.DataFrame(all_candles)
        ohlcv_df = spark.createDataFrame(
            pdf, schema=SchemaOHLCV.add(T.StructField("symbol", T.StringType()))
        )
        self.logger.info("Converted to Spark DataFrame: %s", ohlcv_df.printSchema())

        # Adjust timestamp as before
        timestamp_df = ohlcv_df.withColumn(
            "timestamp", F.from_unixtime(F.unix_timestamp("timestamp") - 4 * 3600)
        )
        self.logger.info("Adjusted timestamp: %s", timestamp_df.printSchema())

        return timestamp_df.orderBy("timestamp").cache()

    def get_cumsum_window(self) -> W.Window:
        # Define window for cumulative sum
        self.logger.debug("Defining cumulative sum window...")
        return (
            W.Window.partitionBy("symbol")
            .orderBy("timestamp")
            .rowsBetween(W.Window.unboundedPreceding, 0)
        )

    def get_returns_df(
        self, candles_df: DataFrame | None = None, spark: SparkSession | None = None
    ) -> DataFrame:
        if candles_df is None:
            candles_df = self.get_candles_df(spark=spark)

        self.logger.debug("Calculating returns...")
        return (
            candles_df.withColumn(
                "return",
                (
                    F.col("close")
                    - F.lag("close").over(W.Window.partitionBy("symbol").orderBy("timestamp"))
                )
                / F.lag("close").over(W.Window.partitionBy("symbol").orderBy("timestamp")),
            )
            .withColumn(
                "log_return",
                F.log(
                    F.col("close")
                    / F.lag("close").over(W.Window.partitionBy("symbol").orderBy("timestamp"))
                ),
            )
            .withColumn(
                "total_return", F.exp(F.sum("log_return").over(self.get_cumsum_window())) - 1
            )
        )

    def get_volatility_df(
        self, returns_df: DataFrame | None = None, spark: SparkSession | None = None
    ) -> DataFrame:
        if returns_df is None:
            returns_df = self.get_returns_df(spark)

        periods = 24
        self.logger.debug("Calculating volatility for %s periods", periods)

        # Count the number of non-null returns in the window
        count_window = (
            W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-periods + 1, 0)
        )

        return (
            returns_df.withColumn("count", F.count("log_return").over(count_window))
            .withColumn(
                "volatility",
                F.when(
                    F.col("count") >= periods,
                    F.stddev(F.col("log_return")).over(count_window) * F.sqrt(F.lit(periods)),
                ),
            )
            .drop("count")
        )

    def is_btc(self, df: DataFrame) -> DataFrame:
        return df.filter(F.col("symbol") == F.lit("BTC"))

    def get_beta_df(
        self,
        returns_df: DataFrame | None = None,
        spark: SparkSession | None = None,
        periods: int | None = None,
    ) -> DataFrame:
        if periods is None:
            periods = self.days * 24 - 1

        if returns_df is None:
            returns_df = self.get_returns_df(spark)

        self.logger.debug("Calculating beta for %s periods", periods)

        # Get BTC returns
        btc_returns = (
            returns_df.filter(F.col("symbol") == "BTC")
            .select("timestamp", "log_return")
            .withColumnRenamed("log_return", "btc_return")
        )

        # Join BTC returns with all symbols
        joined_df = returns_df.join(btc_returns, "timestamp", "left")

        # Define window for rolling calculations
        rolling_window = (
            W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-periods + 1, 0)
        )

        # Calculate rolling covariance and variance
        beta_df = (
            joined_df.withColumn("count", F.count("log_return").over(rolling_window))
            .withColumn(
                "covariance",
                F.when(
                    F.col("count") >= periods,
                    F.covar_pop("log_return", "btc_return").over(rolling_window),
                ),
            )
            .withColumn(
                "btc_variance",
                F.when(F.col("count") >= periods, F.var_pop("btc_return").over(rolling_window)),
            )
            .withColumn("beta", F.col("covariance") / F.col("btc_variance"))
            .withColumn(
                "btc_total_return", F.exp(F.sum("btc_return").over(self.get_cumsum_window()))
            )
        )

        return beta_df.withColumn(
            "adj_return",
            F.when(F.col("beta") > 0, F.col("total_return") / F.col("beta")).otherwise(
                F.col("total_return") * (1 - F.col("beta"))
            ),
        )

    def save_csv(self, name: str, df: DataFrame) -> None:
        df.coalesce(1).write.mode("overwrite").option("header", "true").format("csv").save(
            f"{name}_temp"
        )

        dir_path = Path(f"{name}_temp")
        csv_file = next(dir_path.glob("*.csv"))
        csv_file.rename(f"{name}.csv")

        # Delete all files in beta_temp directory
        for file in dir_path.iterdir():
            file.unlink()

        # Now the directory will be empty and can be removed
        dir_path.rmdir()
        self.logger.info("Saved to %s.csv", name)

    def run(self) -> None:
        spark = self._get_spark()

        # Get candles data regardless of whether beta.csv exists
        self.logger.info("Starting pipeline...")
        candles_df = asyncio.run(self.get_candles_df(spark=spark))
        self.logger.info("Candles DataFrame: %s", candles_df.show(truncate=False))

        returns_df = self.get_returns_df(candles_df)
        self.logger.info("Returns DataFrame: %s", returns_df.show(truncate=False))

        vol_df = self.get_volatility_df(returns_df)
        self.logger.info("Volatility DataFrame: %s", vol_df.show(truncate=False))

        beta_df = self.get_beta_df(vol_df)
        self.logger.info("Beta DataFrame: %s", beta_df.show(truncate=False))
        self.save_csv("beta", beta_df)

        beta_df = spark.read.csv("beta.csv", header=True, inferSchema=True)

        sample_df = (
            beta_df.filter(F.col("symbol").isNotNull())
            .dropna()
            .select(
                F.col("timestamp"),
                F.col("symbol"),
                F.col("beta"),
                (F.col("total_return") * F.lit(100)).alias("total_return_pct"),
                (F.col("adj_return") * F.lit(100)).alias("adj_return_pct"),
            )
            .orderBy("timestamp", "adj_return_pct", "beta")
            .cache()
        )

        self.logger.info("Sample DataFrame: %s", sample_df.show(truncate=False))
        self.save_csv("sample", sample_df)


if __name__ == "__main__":
    pipeline = Pipeline()
    pipeline.run()

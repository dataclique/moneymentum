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
        self.periods = days * 24
        self.logger = self._setup_logging(log_level)
        self.spark = self._get_spark()
        self.data_dir = "data"
        self.ohlcv_dir = f"{self.data_dir}/hyperliquid-ohlcv"

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

    async def get_candles_df(self) -> DataFrame:
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
        ohlcv_df = self.spark.createDataFrame(
            pdf, schema=SchemaOHLCV.add(T.StructField("symbol", T.StringType()))
        )
        self.logger.info("Converted to Spark DataFrame: %s", ohlcv_df.printSchema())

        # # Adjust timestamp as before
        # timestamp_df = ohlcv_df.withColumn(
        #     "timestamp", F.from_unixtime(F.unix_timestamp("timestamp") - 4 * 3600)
        # )
        # self.logger.info("Adjusted timestamp: %s", timestamp_df.printSchema())

        return ohlcv_df.orderBy("timestamp").cache()

    def _get_cumsum_window(self) -> W.Window:
        # Keep as internal helper method since it's used by other transforms
        self.logger.debug("Defining cumulative sum window...")
        return (
            W.Window.partitionBy("symbol")
            .orderBy("timestamp")
            .rowsBetween(W.Window.unboundedPreceding, 0)
        )

    def with_returns(self, df: DataFrame) -> DataFrame:
        self.logger.debug("Calculating returns...")
        return (
            df.withColumn(
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
                "cum_return", F.exp(F.sum("log_return").over(self._get_cumsum_window())) - 1
            )
        )

    def with_volatility(self, df: DataFrame) -> DataFrame:
        # we have self.periods candles, so self.periods - 1 returns
        return_periods = self.periods - 1
        self.logger.debug("Calculating volatility for %s periods", return_periods)

        count_window = (
            W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-return_periods + 1, 0)
        )

        return (
            df.withColumn("count", F.count("log_return").over(count_window))
            .withColumn(
                "stddev",
                F.when(
                    F.col("count") >= return_periods,
                    F.stddev(F.col("log_return")).over(count_window),
                ),
            )
            .withColumn(
                "volatility",
                F.when(
                    F.col("count") >= return_periods,
                    F.col("stddev") * F.sqrt(F.lit(return_periods)),
                ),
            )
            .drop("count")
        )

    def with_beta(self, df: DataFrame) -> DataFrame:
        return_periods = self.periods - 1
        self.logger.debug("Calculating beta for %s periods", return_periods)

        # Get BTC returns
        btc_returns = df.filter(F.col("symbol") == "BTC").select(
            F.col("timestamp"), F.col("log_return").alias("btc_return")
        )

        # Join BTC returns with all symbols
        joined_df = df.join(btc_returns, "timestamp", "left")

        # Define window for rolling calculations
        rolling_window = (
            W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-return_periods + 1, 0)
        )

        # Calculate rolling covariance and variance
        return (
            joined_df.withColumn("count", F.count("log_return").over(rolling_window))
            .withColumn(
                "covariance",
                F.when(
                    F.col("count") >= return_periods,
                    F.covar_pop("log_return", "btc_return").over(rolling_window),
                ),
            )
            .withColumn(
                "btc_variance",
                F.when(
                    F.col("count") >= return_periods, F.var_pop("btc_return").over(rolling_window)
                ),
            )
            .withColumn("beta", F.col("covariance") / F.col("btc_variance"))
            .withColumn(
                "btc_cum_return", F.exp(F.sum("btc_return").over(self._get_cumsum_window()))
            )
        )

    def with_adj_return(self, df: DataFrame) -> DataFrame:
        return df.withColumn(
            "adj_return",
            F.when(F.col("beta") > 0, F.col("cum_return") / F.col("beta")).otherwise(
                F.col("cum_return") * (1 - F.col("beta"))
            ),
        )

    def with_information_discreteness(self, df: DataFrame) -> DataFrame:
        self.logger.debug("Calculating information discreteness...")

        # Calculate sign of overall return
        window = self._get_cumsum_window()

        return (
            df.withColumn("return_sign", F.signum(F.col("cum_return")))
            .withColumn("is_positive_return", F.when(F.col("log_return") > 0, 1).otherwise(0))
            .withColumn("is_negative_return", F.when(F.col("log_return") < 0, 1).otherwise(0))
            .withColumn("num_samples", F.count("log_return").over(window))
            .withColumn(
                "pct_positive", F.sum("is_positive_return").over(window) / F.col("num_samples")
            )
            .withColumn(
                "pct_negative", F.sum("is_negative_return").over(window) / F.col("num_samples")
            )
            .withColumn(
                "information_discreteness",
                F.col("return_sign") * (F.col("pct_negative") - F.col("pct_positive")),
            )
            .drop(
                "is_positive_return",
                "is_negative_return",
                "num_samples",
                "pct_positive",
                "pct_negative",
                "return_sign",
            )
        )

    def save_csv(self, name: str, df: DataFrame) -> None:
        # Ensure data directory exists
        Path(self.data_dir).mkdir(exist_ok=True)

        # Save as a single CSV file
        output_path = f"{self.data_dir}/{name}"
        df.coalesce(1).write.mode("overwrite").option("header", "true").csv(output_path)

        # Get the CSV file from the directory and move it
        dir_path = Path(output_path)
        csv_file = next(dir_path.glob("*.csv"))
        target_path = dir_path.parent / f"{name}.csv"
        csv_file.rename(target_path)

        # Clean up the directory
        for file in dir_path.iterdir():
            file.unlink()
        dir_path.rmdir()
        self.logger.info("Saved to %s", target_path)

    def run(self) -> None:
        self.logger.info("Starting pipeline...")

        candles_file_name = "ohlcv"
        candles_path = f"{self.data_dir}/{candles_file_name}.csv"

        if not Path(candles_path).exists():
            candles_df = asyncio.run(self.get_candles_df())
            self.logger.info("Candles DataFrame: %s", candles_df.show(truncate=False))
            self.save_csv(candles_file_name, candles_df)

        candles_df = self.spark.read.csv(candles_path, header=True, inferSchema=True)

        transformed_df = (
            candles_df.transform(self.with_returns)
            .transform(self.with_volatility)
            .transform(self.with_beta)
            .transform(self.with_adj_return)
            .transform(self.with_information_discreteness)
        )

        self.logger.info("Beta DataFrame:")
        transformed_df.show()
        self.save_csv("beta", transformed_df)

        sample_df = (
            transformed_df.withColumn("cum_return_pct", F.col("cum_return") * F.lit(100))
            .withColumn("adj_return_pct", F.col("adj_return") * F.lit(100))
            .dropna()
            .select(
                F.col("timestamp"),
                F.col("symbol"),
                F.col("stddev"),
                F.col("volatility"),
                F.col("beta"),
                F.col("cum_return_pct"),
                F.col("adj_return_pct"),
                F.col("information_discreteness"),
            )
            .orderBy("timestamp", "adj_return_pct", "beta")
            .cache()
        )

        self.logger.info("Sample DataFrame:")
        sample_df.show(truncate=False)
        self.save_csv("sample", sample_df)


if __name__ == "__main__":
    pipeline = Pipeline()
    pipeline.run()

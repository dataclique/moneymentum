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

    async def fetch_funding_rate_history(
        self,
        exchange: ccxt.Exchange,
        symbol: str,
        since: int,
    ) -> list[dict[str, Any]]:
        """Fetch funding rate history for a single symbol asynchronously, handling pagination."""
        all_funding_rates = []
        current_since = since

        try:
            while True:
                self.logger.debug("Fetching funding rate for %s since %s...", symbol, current_since)
                funding_rates = await exchange.fetch_funding_rate_history(
                    symbol, since=current_since
                )

                if not funding_rates:
                    self.logger.info("No more funding rates found for %s.", symbol)
                    break

                self.logger.info("Fetched %s funding rates for %s", len(funding_rates), symbol)

                # Add the current batch of funding rates to the list
                all_funding_rates.extend(
                    {
                        "timestamp": datetime.fromtimestamp(
                            rate["timestamp"] / 1000, tz=timezone.utc
                        ),
                        "funding_rate": rate["fundingRate"],
                        "symbol": symbol.replace("/", "_").replace(":", "_").replace("_USDC", ""),
                    }
                    for rate in funding_rates
                )

                # Update `current_since` for the next batch (timestamp of the last record + 1 ms)
                current_since = funding_rates[-1]["timestamp"] + 1

                # If fewer records than the API's max limit are returned,
                # we've fetched all available data
                # Maximum we can get for 1 call is 500 (I got this number experimatally)
                max_records_of_funding_rates_for_one_call = 500

                if len(funding_rates) < max_records_of_funding_rates_for_one_call:
                    break

        except (ccxt.NetworkError, ccxt.ExchangeError):
            self.logger.exception("Error fetching funding rate for %s", symbol)

        return all_funding_rates

    async def fetch_all_data(
        self, exchange: ccxt.Exchange, symbols: list[str], timeframe: str, since: int
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV and funding rate data for all symbols concurrently."""
        ohlcv_tasks = [self.fetch_ohlcv(exchange, symbol, timeframe, since) for symbol in symbols]
        funding_rate_tasks = [
            self.fetch_funding_rate_history(exchange, symbol, since) for symbol in symbols
        ]

        ohlcv_results = await asyncio.gather(*ohlcv_tasks)
        funding_rate_results = await asyncio.gather(*funding_rate_tasks)

        ohlcv_data = [candle for candles in ohlcv_results for candle in candles]
        funding_rate_data = [rate for rates in funding_rate_results for rate in rates]

        # neeed this, cause for ohlcv and funding_rate
        # we have different timestamps with different types:
        # ohlcv format:        2024-11-26T15:00:00+00:00
        # funding_rate format: 2024-11-26T15:00:00.097000+00:00
        def normalize_timestamp(timestamp: str | datetime) -> datetime:
            if isinstance(timestamp, datetime):
                # If it's already a datetime object, normalize it and return
                return timestamp.replace(microsecond=0)
            if isinstance(timestamp, str):
                # If it's a string, parse it and return as a datetime object
                return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).replace(
                    microsecond=0
                )
            error_message = f"Unsupported timestamp type: {type(timestamp)}"
            raise TypeError(error_message)

        for rate in funding_rate_data:
            rate["timestamp"] = normalize_timestamp(rate["timestamp"])
        for candle in ohlcv_data:
            candle["timestamp"] = normalize_timestamp(candle["timestamp"])

        funding_rate_map = {
            (rate["symbol"], rate["timestamp"]): rate["funding_rate"] for rate in funding_rate_data
        }
        for candle in ohlcv_data:
            candle["funding_rate"] = funding_rate_map.get(
                (candle["symbol"], candle["timestamp"]), None
            )

        return ohlcv_data

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

        # Fetch all data concurrently
        all_data = await self.fetch_all_data(exchange, perp_symbols, timeframe, since)

        self.logger.info("Fetched %s records", len(all_data))

        # Convert to pandas then to Spark DataFrame
        pdf = pd.DataFrame(all_data)

        # Create Spark DataFrame
        ohlcv_df = self.spark.createDataFrame(
            pdf,
            schema=SchemaOHLCV.add(T.StructField("symbol", T.StringType())).add(
                T.StructField("funding_rate", T.DoubleType())
            ),
        )

        # ohlcv_df = self.spark.createDataFrame(pdf, schema=SchemaOHLCV)
        self.logger.info("Converted to Spark DataFrame: %s", ohlcv_df.printSchema())

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
        transformed_df.show(truncate=False)
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
                F.col("funding_rate"),
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

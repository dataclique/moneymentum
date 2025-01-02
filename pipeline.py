import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import colorlog
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W
from statsmodels.tsa.stattools import adfuller, coint


def plot_returns(Xs: list[pd.Series]) -> None:
    for X in Xs:
        X_return = X.pct_change()[1:]
        plt.hist(X_return, bins=20, label=X.name)

    plt.xlabel("Return")
    plt.ylabel("Frequency")
    plt.legend()
    plt.show()


def plot_price(X: pd.Series, ticker: str) -> None:
    SMA7D = X.rolling(window=7).mean()
    SMA30D = X.rolling(window=30).mean()
    SMA90D = X.rolling(window=90).mean()

    plt.plot(X.index, X.values)
    plt.plot(SMA7D.index, SMA7D.values)
    plt.plot(SMA30D.index, SMA30D.values)
    plt.plot(SMA90D.index, SMA90D.values)

    plt.ylabel("Price")
    plt.legend([ticker, "7D SMA", "30D SMA", "90D SMA"])


def get_ticker_price_pdf(ticker: str, candles_df: DataFrame) -> pd.Series:
    prices = candles_df.filter(F.col("symbol") == ticker).toPandas().set_index("timestamp")["close"]
    prices.name = ticker
    return prices


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


class Pipeline:
    def __init__(
        self,
        lookback_periods: int = 30 * 24,
        forward_periods: int = 7 * 24,
        log_level: int = logging.DEBUG,
    ) -> None:
        self.logger = self._setup_logging(log_level)
        self.spark = self._get_spark()
        self.data_dir = "data"
        self.ohlcv_dir = f"{self.data_dir}/hyperliquid-ohlcv"

        self.lookback_periods = lookback_periods
        self.forward_periods = forward_periods
        self.symbol_window = W.Window.partitionBy("symbol").orderBy("timestamp")
        self.rolling_window = self.symbol_window.rowsBetween(-lookback_periods + 1, 0)
        self.forward_window = self.symbol_window.rowsBetween(0, forward_periods)
        self.cumsum_window = self.symbol_window.rowsBetween(W.Window.unboundedPreceding, 0)

    def _setup_logging(self, log_level: int) -> logging.Logger:
        # Console handler provides colored logs to the terminal
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(
            colorlog.ColoredFormatter(
                fmt="%(log_color)s%(levelname)s:%(name)s: %(reset)s%(message)s",
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
        spark = (
            SparkSession.builder.appName("pipeline")
            .config("spark.sql.adaptive.enabled", "true")
            .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
            .config("spark.sql.shuffle.partitions", "200")
            .config("spark.default.parallelism", "200")
            .config("spark.sql.broadcastTimeout", "600")
            .getOrCreate()
        )
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

        # https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#candle-snapshot
        HL_OHLCV_LIMIT = 5000
        rng = np.random.default_rng()
        random_delay = rng.uniform(0.01, 300)
        await asyncio.sleep(random_delay)

        try:
            self.logger.debug(
                "Fetching %s candles after sleeping %s seconds...", symbol, random_delay
            )
            ohlcv = await exchange.fetch_ohlcv(
                symbol,
                timeframe,
                since=since,
                limit=HL_OHLCV_LIMIT,
            )
            self.logger.info("Fetched %s %s candles", len(ohlcv), symbol)

            ticker = symbol.replace("/", "_").replace(":", "_").replace("_USDC", "")

            return [
                {
                    "timestamp": datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc),
                    "open": candle[1],
                    "high": candle[2],
                    "low": candle[3],
                    "close": candle[4],
                    "volume": candle[5],
                    "symbol": symbol,
                    "ticker": ticker,
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

    async def get_candles_df(self, timeframe: str = "1h") -> DataFrame:
        self.logger.debug("Initializing exchange...")
        exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        self.logger.info("Exchange initialized: %s", exchange)

        # Only last 5000 candles available
        start_date = datetime(2024, 1, 1, tzinfo=timezone.utc).replace(hour=0, minute=0, second=0)
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
        ohlcv_df = self.spark.createDataFrame(pdf, schema=SchemaOHLCV)
        self.logger.info("Converted to Spark DataFrame: %s", ohlcv_df.printSchema())

        candles_df = ohlcv_df.orderBy("timestamp")
        candles_file_name = f"ohlcv{timeframe}"
        self.save_csv(candles_file_name, candles_df)

        candles_path = f"{self.data_dir}/{candles_file_name}.csv"
        return self.spark.read.schema(SchemaOHLCV).csv(candles_path).cache()

    def test_stationarity(self, timeseries: pd.Series, cutoff: float = 0.01) -> bool:
        pvalue = adfuller(timeseries)[1]
        if pvalue < cutoff:
            self.logger.info("%s is likely stationary", timeseries.name)
            return True

        self.logger.error("%s is likely not stationary", timeseries.name)
        return False

    def test_cointegration(self, X: pd.Series, Y: pd.Series, cutoff: float = 0.01) -> bool:
        res = coint(X, Y)
        _, pvalue, _ = res
        if pvalue < cutoff:
            self.logger.info("%s and %s are likely cointegrated", X.name, Y.name)
            self.logger.debug("result: %s", res)
            return True

        self.logger.error("%s and %s are likely not cointegrated", X.name, Y.name)
        return False

    def with_returns(self, df: DataFrame) -> DataFrame:
        self.logger.debug("Calculating returns...")
        return (
            df.withColumn("count", F.count("close").over(self.symbol_window))
            .withColumn(
                "return",
                (F.col("close") - F.lag("close").over(self.symbol_window))
                / F.lag("close").over(self.symbol_window),
            )
            .withColumn(
                "log_return",
                F.log(F.col("close") / F.lag("close").over(self.symbol_window)),
            )
            .withColumn(
                "cum_return",
                F.when(
                    F.col("count") >= self.lookback_periods,
                    F.exp(F.sum("log_return").over(self.rolling_window)) - 1,
                ),
            )
        )

    def with_bollinger(self, df: DataFrame) -> DataFrame:
        self.logger.debug("Calculating bollinger bands...")
        df.show()

        return (
            df.withColumn(
                "sma",
                F.when(
                    F.col("count") > self.lookback_periods, F.avg("close").over(self.rolling_window)
                ),
            )
            .withColumn("price_stddev", F.stddev("close").over(self.rolling_window))
            .withColumn("return_stddev", F.stddev("log_return").over(self.rolling_window))
            .withColumn("bollinger_upper", F.col("sma") + (F.col("price_stddev") * 2))
            .withColumn("bollinger_lower", F.col("sma") - (F.col("price_stddev") * 2))
            .withColumn(
                "max",
                F.when(
                    F.col("count") >= self.lookback_periods,
                    F.max("high").over(self.rolling_window),
                ),
            )
            .withColumn(
                "min",
                F.when(
                    F.col("count") >= self.lookback_periods,
                    F.min("low").over(self.rolling_window),
                ),
            )
        )

    def with_zscore(self, df: DataFrame) -> DataFrame:
        return (
            df.withColumn("price_zscore", (F.col("close") - F.col("sma")) / F.col("price_stddev"))
            .withColumn("z_max", F.max(F.abs("price_zscore")).over(self.rolling_window))
            .withColumn("z_to_max", F.col("price_zscore") / F.col("z_max"))
        )

    def with_auto_regression(self, df: DataFrame) -> DataFrame:
        return df.withColumn(
            "auto_regression",
            F.corr(F.col("log_return"), F.lag("log_return", 1).over(self.symbol_window)).over(
                self.rolling_window
            ),
        )

    def with_forward_return(self, df: DataFrame) -> DataFrame:
        return df.withColumn(
            "forward_return", F.exp(F.sum("log_return").over(self.forward_window)) - 1
        ).withColumn(
            "price_zscore_fw_return_corr",
            F.corr(F.col("price_zscore"), F.col("forward_return")).over(self.rolling_window),
        )

    def with_volatility(self, df: DataFrame) -> DataFrame:
        return (
            df.withColumn("count", F.count("log_return").over(self.rolling_window))
            .withColumn(
                "stddev",
                F.stddev(F.col("log_return")).over(self.rolling_window),
            )
            .withColumn(
                "annualized_volatility",
                F.col("stddev") * F.sqrt(F.lit(365 * 24)),
            )
            .drop("count")
        )

    def with_beta(self, df: DataFrame) -> DataFrame:
        self.logger.debug("Calculating beta...")

        # Get BTC returns
        btc_returns = df.filter(F.col("ticker") == "BTC").select(
            F.col("timestamp"), F.col("log_return").alias("btc_return")
        )

        # Join BTC returns with all symbols
        joined_df = df.join(btc_returns, "timestamp", "left")

        # Calculate rolling covariance and variance
        return (
            joined_df.withColumn("count", F.count("log_return").over(self.rolling_window))
            .withColumn(
                "covariance",
                F.covar_pop("log_return", "btc_return").over(self.rolling_window),
            )
            .withColumn(
                "btc_variance",
                F.var_pop("btc_return").over(self.rolling_window),
            )
            .withColumn("beta", F.col("covariance") / F.col("btc_variance"))
            .withColumn("btc_cum_return", F.exp(F.sum("btc_return").over(self.cumsum_window)))
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
        return (
            df.withColumn("return_sign", F.signum(F.col("cum_return")))
            .withColumn("is_positive_return", F.when(F.col("log_return") > 0, 1).otherwise(0))
            .withColumn("is_negative_return", F.when(F.col("log_return") < 0, 1).otherwise(0))
            .withColumn("num_samples", F.count("log_return").over(self.cumsum_window))
            .withColumn(
                "pct_positive",
                F.sum("is_positive_return").over(self.cumsum_window) / F.col("num_samples"),
            )
            .withColumn(
                "pct_negative",
                F.sum("is_negative_return").over(self.cumsum_window) / F.col("num_samples"),
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

        # Convert timestamp to UTC before saving
        df_utc = df.withColumn(
            "timestamp", F.from_utc_timestamp(F.to_utc_timestamp(F.col("timestamp"), "UTC"), "UTC")
        )

        # Save as a single CSV file with UTC timestamp format
        output_path = f"{self.data_dir}/{name}"
        df_utc.coalesce(1).write.mode("overwrite").option("header", "true").option(
            "timestampFormat", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        ).csv(output_path)

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

        reload = False
        path = "data/ohlcv1h.csv"
        if reload or not Path(path).exists():
            candles_df = asyncio.run(self.get_candles_df())
        else:
            candles_df = self.spark.read.schema(SchemaOHLCV).csv(path, header=True)

        self.logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)
        candles_df.describe().show()

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
                F.col("ticker"),
                F.col("stddev"),
                F.col("annualized_volatility"),
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

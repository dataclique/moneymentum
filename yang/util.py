import logging
import math
from pathlib import Path
from typing import Literal, TypedDict

import colorlog
import matplotlib.pyplot as plt
import pandas as pd
from py4j.protocol import Py4JNetworkError
from pyspark.sql import DataFrame, DataFrameReader, SparkSession
from pyspark.sql import functions as F
from statsmodels.tsa.stattools import adfuller, coint

DEBUG = True
LOG_LEVEL = logging.DEBUG if DEBUG else logging.INFO

logger = logging.getLogger(__name__)
logger.setLevel(LOG_LEVEL)


class TimeframeConfig(TypedDict):
    lookback_periods: int
    n_tokens: int
    time_in_ms: int
    annualized_factor: int
    min_acceptable_return: float


Timeframe = Literal["15m", "1h", "1d", "1w"]

# min_acceptable_return Based on HyperLiquid neutral funding rates.
# See funding comparison page for more details:
# https://app.hyperliquid.xyz/fundingComparison
TIMEFRAME_CONFIGS: dict[Timeframe, TimeframeConfig] = {
    "1w": {
        "lookback_periods": 52,
        "n_tokens": 2,
        "time_in_ms": 7 * 24 * 60 * 60 * 1000,
        "annualized_factor": 52,
        "min_acceptable_return": 0.0021,  # 0.21%
    },
    "1d": {
        "lookback_periods": 90,
        "n_tokens": 6,
        "time_in_ms": 24 * 60 * 60 * 1000,
        "annualized_factor": 365,
        "min_acceptable_return": 0.0003,  # 0.03%
    },
    "1h": {
        "lookback_periods": 7 * 24,
        "n_tokens": 5,
        "time_in_ms": 60 * 60 * 1000,
        "annualized_factor": 365 * 24,
        "min_acceptable_return": 0.000013,  # 0.0013%
    },
    "15m": {
        "lookback_periods": 7 * 24 * 4,
        "n_tokens": 10,
        "time_in_ms": 15 * 60 * 1000,
        "annualized_factor": 365 * 24 * 4,
        "min_acceptable_return": math.sqrt(math.sqrt(1.000013)) - 1,
    },
}


def plot_returns(Xs: list[pd.Series]) -> None:
    for X in Xs:
        X_return = X.pct_change()[1:]
        plt.hist(X_return, bins=20, label=str(X.name))

    plt.xlabel("Return")
    plt.ylabel("Frequency")
    plt.legend()
    plt.show()


def plot_price(X: pd.Series, ticker: str) -> None:
    SMA7D = X.rolling(window=7).mean()
    SMA30D = X.rolling(window=30).mean()
    SMA90D = X.rolling(window=90).mean()

    plt.plot(X.index, X.to_numpy())
    plt.plot(SMA7D.index, SMA7D.to_numpy())
    plt.plot(SMA30D.index, SMA30D.to_numpy())
    plt.plot(SMA90D.index, SMA90D.to_numpy())

    plt.ylabel("Price")
    plt.legend([ticker, "7D SMA", "30D SMA", "90D SMA"])


def get_ticker_price_pdf(ticker: str, candles_df: DataFrame) -> pd.Series:
    prices = candles_df.filter(F.col("symbol") == ticker).toPandas().set_index("timestamp")["close"]
    prices.name = ticker
    return prices


def setup_logging() -> None:
    # Console handler provides colored logs to the terminal
    console_handler = logging.StreamHandler()
    fmt = (
        "%(thin_white)s%(asctime)s%(reset)s "
        "%(log_color)s%(levelname)s %(name)s%(reset)s %(message)s"
    )
    console_handler.setFormatter(
        colorlog.ColoredFormatter(
            fmt=fmt,
            log_colors={
                "DEBUG": "blue",
                "INFO": "green",
                "WARNING": "yellow",
                "ERROR": "red",
                "CRITICAL": "red,bg_white",
            },
            secondary_log_colors={
                "thin_white": {
                    "DEBUG": "thin_white",
                    "INFO": "thin_white",
                    "WARNING": "thin_white",
                    "ERROR": "thin_white",
                    "CRITICAL": "thin_white",
                }
            },
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )

    # File handler saves all logs to a file
    logging.basicConfig(
        level=logging.ERROR,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
        handlers=[
            console_handler,
            logging.FileHandler("pipeline.log"),
        ],
    )


def get_spark() -> SparkSession:
    logger.debug("Creating Spark session...")

    parallelism = 100
    ram_gigs = 12
    cores = 12

    # JDBC_DRIVER_PATH = os.getenv("JDBC_PATH")

    spark = (
        SparkSession.builder.appName("moneymentum")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config(
            "spark.driver.port", "4040"
        )  # Use 4040, this is the standard port for Spark, if not taken
        .config("spark.ui.port", "4041")  # Port for Spark UI
        # ---------------------------------------------------
        # .config("spark.driver.extraClassPath", JDBC_DRIVER_PATH)
        # Memory and Spill Configurations
        .config("spark.memory.fraction", "0.8")
        .config("spark.memory.storageFraction", "0.3")
        .config("spark.memory.offHeap.enabled", "true")
        .config("spark.memory.offHeap.size", "2g")
        .config("spark.shuffle.file.buffer", "1m")
        .config("spark.disk.spillCompress", "true")
        .config("spark.shuffle.compress", "true")
        .config("spark.shuffle.spill.compress", "true")
        # Existing configurations...
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
        .config("spark.executor.memory", f"{ram_gigs}g")
        .config("spark.driver.memory", f"{ram_gigs}g")
        .config("spark.sql.shuffle.partitions", parallelism)
        .config("spark.executor.cores", cores)
        .config("spark.driver.cores", cores)
        .config("spark.sql.files.maxPartitionBytes", "128m")  # Larger partition size
        .config("spark.sql.inMemoryColumnarStorage.compressed", "true")
        .config("spark.sql.inMemoryColumnarStorage.batchSize", "10000")
        .master("local[*]")  # Make sure this line is present and below all .config()
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")
    logger.debug("Spark session created.")
    return spark


def get_spark_pg_df_reader(
    spark: SparkSession, db_url: str, db_user: str, db_password: str
) -> DataFrameReader:
    """Create a DataFrameReader for connecting to a PostgreSQL database."""
    return (
        spark.read.format("jdbc")
        .option("driver", "org.postgresql.Driver")
        .option("url", db_url)
        .option("user", db_user)
        .option("password", db_password)
    )


DATA_DIR = "data"


def save_csv(name: str, df: DataFrame) -> None:
    """Save a Spark DataFrame to a single CSV file inside the ``data`` directory.

    The implementation first tries an efficient Spark write with
    ``repartition(1)``.  On some machines a very large shuffle or a driver
    memory-starved environment can make the JVM disappear, which surfaces as
    ``Py4JNetworkError: Answer from Java side is empty``.  In that case we fall
    back to collecting the frame on the driver and letting pandas write the
    CSV so that the rest of the pipeline can continue.
    """
    Path(DATA_DIR).mkdir(exist_ok=True)
    output_path = Path(DATA_DIR) / name

    try:
        # Using ``repartition(1)`` avoids the huge shuffle that ``coalesce``
        # sometimes triggers while still giving us a single-file output.
        df.repartition(1).write.mode("overwrite").option("header", "true").option(
            "timestampFormat",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        ).csv(str(output_path))

        # Grab the produced part-file and move/rename it next to the directory.
        part_file = next(output_path.glob("part-*.csv"))
        target_path = output_path.with_suffix(".csv")
        part_file.replace(target_path)
        # Clean up Spark's metadata files / temporary dir.
        for extra in output_path.iterdir():
            extra.unlink()
        output_path.rmdir()
        logger.info("Saved to %s", target_path)
    except (Py4JNetworkError, Exception) as exc:  # broad fallback but we log.
        logger.warning("Spark writer failed (%s). Falling back to pandas CSV writer.", exc)
        target_path = Path(DATA_DIR) / f"{name}.csv"
        _pd_df = df.toPandas()
        _pd_df.to_csv(target_path, index=False)
        logger.info("Saved (pandas) to %s", target_path)


def test_stationarity(timeseries: pd.Series, cutoff: float = 0.01) -> bool:
    pvalue = adfuller(timeseries)[1]
    if pvalue < cutoff:
        logger.info("%s is likely stationary", timeseries.name)
        return True

    logger.error("%s is likely not stationary", timeseries.name)
    return False


def test_cointegration(X: pd.Series, Y: pd.Series, cutoff: float = 0.01) -> bool:
    res = coint(X, Y)
    _, pvalue, _ = res
    if pvalue < cutoff:
        logger.info("%s and %s are likely cointegrated", X.name, Y.name)
        logger.debug("result: %s", res)
        return True

    logger.error("%s and %s are likely not cointegrated", X.name, Y.name)
    return False

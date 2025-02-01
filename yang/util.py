import logging
import os
from pathlib import Path

import colorlog
import matplotlib.pyplot as plt
import pandas as pd
from pyspark.sql import DataFrame, DataFrameReader, SparkSession
from pyspark.sql import functions as F
from statsmodels.tsa.stattools import adfuller, coint

DEBUG = True


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


LOG_LEVEL = logging.DEBUG

logger = logging.getLogger(__name__)
logger.setLevel(LOG_LEVEL)


def get_spark() -> SparkSession:
    logger.debug("Creating Spark session...")

    parallelism = 100
    ram_gigs = 12
    cores = 12

    JDBC_DRIVER_PATH = os.getenv("JDBC_PATH")

    spark = (
        SparkSession.builder.appName("pipeline")
        .config("spark.driver.extraClassPath", JDBC_DRIVER_PATH)
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
    # Ensure data directory exists
    Path(DATA_DIR).mkdir(exist_ok=True)

    # Save as a single CSV file with UTC timestamp format
    output_path = f"{DATA_DIR}/{name}"

    df.coalesce(1).write.mode("overwrite").option("header", "true").option(
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
    logger.info("Saved to %s", target_path)


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

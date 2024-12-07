import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W


def get_all_pairs_candles_hyperliquid() -> None:
    if not Path("data").exists():
        Path("data").mkdir(parents=True)

    exchange = ccxt.hyperliquid()

    # every hour for last 7 days in ms
    timeframe = "1h"
    since = int((datetime.now(timezone.utc) - timedelta(days=7)).timestamp() * 1000)

    # All trade pairs
    markets = exchange.load_markets()
    symbols = list(markets.keys())
    perp_symbols = [s for s in symbols if "PERP" in s or markets[s].get("type") == "swap"]

    for symbol in perp_symbols:
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, timeframe, since=since)

            ohlcv_data = [
                {
                    "timestamp": datetime.fromtimestamp(
                        candle[0] / 1000, tz=timezone.utc
                    ).isoformat(),
                    "open": candle[1],
                    "high": candle[2],
                    "low": candle[3],
                    "close": candle[4],
                    "volume": candle[5],
                }
                for candle in ohlcv
            ]

            filename = Path(f"data/{symbol.replace('/', '_').replace(':', '_')}_ohlcv.json")
            with filename.open("w") as file:
                json.dump(ohlcv_data, file, indent=4)

        except Exception:  # noqa: BLE001, PERF203, S110
            pass


def get_spark() -> SparkSession:
    spark = SparkSession.builder.appName("pipeline").getOrCreate()
    spark.sparkContext.setLogLevel("ERROR")
    return spark


ohlcv_dir = "data/hyperliquid/ohlcv"

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


def get_candles_df(spark: SparkSession | None = None) -> DataFrame:
    if spark is None:
        spark = get_spark()

    json_df = (
        spark.read.schema(SchemaOHLCV).option("multiLine", "true").json(f"{ohlcv_dir}/*_ohlcv.json")
    )

    symbol_df = (
        json_df.withColumn("input_file", F.input_file_name())
        .withColumn("symbol", F.regexp_extract("input_file", f"{ohlcv_dir}/(.+?)_ohlcv\.json", 1))
        .withColumn("symbol", F.regexp_replace("symbol", "_USDC.*$", ""))
        .drop("input_file")
    )

    timestamp_df = symbol_df.withColumn("timestamp", F.to_timestamp(F.col("timestamp"))).withColumn(
        "timestamp", F.from_unixtime(F.unix_timestamp("timestamp") - 4 * 3600)
    )
    # day_df = symbol_df.filter(F.date_format("timestamp", "yyyy-MM-dd") == date)

    return timestamp_df.orderBy("timestamp").cache()


def get_cumsum_window() -> W.Window:
    # Define window for cumulative sum
    return (
        W.Window.partitionBy("symbol")
        .orderBy("timestamp")
        .rowsBetween(W.Window.unboundedPreceding, 0)
    )


def get_returns_df(
    candles_df: DataFrame | None = None, spark: SparkSession | None = None
) -> DataFrame:
    if candles_df is None:
        candles_df = get_candles_df(spark=spark)

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
        .withColumn("total_return", F.exp(F.sum("log_return").over(get_cumsum_window())) - 1)
    )


def get_volatility_df(
    returns_df: DataFrame | None = None, spark: SparkSession | None = None
) -> DataFrame:
    if returns_df is None:
        returns_df = get_returns_df(spark)

    periods = 24

    # Count the number of non-null returns in the window
    count_window = W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-periods + 1, 0)

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


def is_btc(df: DataFrame) -> DataFrame:
    return df.filter(F.col("symbol") == F.lit("BTC"))


def get_beta_df(
    returns_df: DataFrame | None = None,
    spark: SparkSession | None = None,
    periods: int = 7 * 24 - 1,
) -> DataFrame:
    if returns_df is None:
        returns_df = get_returns_df(spark)

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
        .withColumn("btc_total_return", F.exp(F.sum("btc_return").over(get_cumsum_window())))
    )

    return beta_df.withColumn(
        "adj_return",
        F.when(F.col("beta") > 0, F.col("total_return") / F.col("beta")).otherwise(
            F.col("total_return") * (1 - F.col("beta"))
        ),
    )


if __name__ == "__main__":
    candles_df = get_candles_df()
    candles_df.show(truncate=False)

    returns_df = get_returns_df(candles_df)
    vol_df = get_volatility_df(returns_df)
    beta_df = get_beta_df(vol_df)

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
        .orderBy("timestamp", "adj_return_pct")
        .cache()
    )

    sample_df.show()
    sample_df.coalesce(1).write.mode("overwrite").csv("beta.csv", header=True)

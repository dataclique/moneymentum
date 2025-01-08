import logging
from dataclasses import dataclass
from typing import Literal

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql import window as W

from yang import util

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


@dataclass
class Chronos:
    lookback_periods: int  # = 30 * 24
    # forward_periods: int  # = 7 * 24
    timeframe: Literal["1h", "1d", "1w"]

    spark = util.get_spark()

    def __post_init__(self) -> None:
        self.symbol_window = W.Window.partitionBy("symbol").orderBy("timestamp")
        self.rolling_window = self.symbol_window.rowsBetween(
            -self.lookback_periods + 1, W.Window.currentRow
        )
        # self.forward_window = self.symbol_window.rowsBetween(0, self.forward_periods)

    def with_returns(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating returns...")
        initial_count = df.select("close").dropna().count()
        ticker_count = len(df.select("ticker").dropna().distinct().collect())
        logger.debug("Initial count: %d; Ticker count: %d", initial_count, ticker_count)

        count_df = df.withColumn("count", F.count("close").over(self.symbol_window)).cache()
        count_count = count_df.select("count").dropna().count()
        assert count_count == initial_count, "Count column count should match initial count"
        logger.debug("Count column count (%d) check passed.", count_count)

        return_df = count_df.withColumn(
            "log_return",
            F.log(F.col("close") / F.lag("close").over(self.symbol_window)),
        )

        return_count = return_df.select("log_return").dropna().count()
        assert 0 < return_count < initial_count, (
            f"Return column count ({return_count})"
            f"should satisfy 0 < {return_count} < {initial_count}"
        )
        logger.debug("Return column count (%d) check passed.", return_count)

        return return_df

    def with_sma(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating SMA...")

        initial_count = df.select("close").dropna().count()
        sma_df = df.withColumn(
            "sma",
            F.when(
                F.col("count") >= self.lookback_periods, F.avg("close").over(self.rolling_window)
            ),
        )

        sma_count = sma_df.select("sma").dropna().count()
        assert (
            0 < sma_count < initial_count
        ), f"SMA column count ({sma_count}) should satisfy 0 < {sma_count} < {initial_count}"
        logger.debug("SMA column count (%d) check passed.", sma_count)

        mean_df = sma_df.withColumn(
            "mean_return",
            F.when(
                F.col("count") > self.lookback_periods,
                F.avg("log_return").over(self.rolling_window),
            ),
        )

        mean_count = mean_df.select("mean_return").dropna().count()
        assert (
            mean_count < sma_count  # -1 because we're looking at a difference
        ), f"Mean return column count ({mean_count}) should equal SMA column count ({sma_count})"
        logger.debug("Mean return column count (%d) check passed.", mean_count)

        stddev_df = mean_df.withColumn(
            "price_stddev",
            F.when(
                F.col("count") > self.lookback_periods, F.stddev("close").over(self.rolling_window)
            ),
        ).withColumn("return_stddev", F.stddev("log_return").over(self.rolling_window))

        stddev_count = stddev_df.select("price_stddev", "return_stddev").dropna().count()
        assert (
            stddev_count == mean_count
        ), f"Price stddev column count ({stddev_count}) should equal {mean_count}"
        logger.debug("Price stddev column count (%d) check passed.", stddev_count)

        max_min_df = stddev_df.withColumn(
            "max",
            F.when(
                F.col("count") >= self.lookback_periods,
                F.max("high").over(self.rolling_window),
            ),
        ).withColumn(
            "min",
            F.when(
                F.col("count") >= self.lookback_periods,
                F.min("low").over(self.rolling_window),
            ),
        )

        min_count = max_min_df.select("min").dropna().count()
        max_count = max_min_df.select("max").dropna().count()
        assert min_count == max_count > stddev_count, (
            f"Should be: min column count ({min_count})"
            f" == max column count ({max_count})"
            f" > stddev count ({stddev_count})"
        )
        logger.debug("Max/min column counts (%d, %d) check passed.", min_count, max_count)

        return max_min_df

    def with_zscore(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating zscore...")
        return (
            df.withColumn("price_zscore", (F.col("close") - F.col("sma")) / F.col("price_stddev"))
            # .withColumn("z_max", F.max(F.abs("price_zscore")).over(self.rolling_window))
            # .withColumn("z_to_max", F.col("price_zscore") / F.col("z_max"))
        )

    def with_volatility(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating volatility...")

        if self.timeframe == "1h":
            annualization_factor = 365 * 24
        elif self.timeframe == "1d":
            annualization_factor = 365
        elif self.timeframe == "1w":
            annualization_factor = 52

        return (
            df.withColumn(
                "stddev",
                F.stddev(F.col("log_return")).over(self.rolling_window),
            )
            .withColumn(
                "annualized_volatility",
                F.col("stddev") * F.sqrt(F.lit(annualization_factor)),
            )
            .drop("count")
        )

    def with_beta(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating beta...")

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
            .withColumn("btc_cum_return", F.exp(F.sum("btc_return").over(self.rolling_window)))
        )

    def with_information_discreteness(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating information discreteness...")

        # Calculate sign of overall return
        return (
            df.withColumn("return_sign", F.signum(F.col("cum_return")))
            .withColumn("is_positive_return", F.when(F.col("log_return") > 0, 1).otherwise(0))
            .withColumn("is_negative_return", F.when(F.col("log_return") < 0, 1).otherwise(0))
            .withColumn("num_samples", F.count("log_return").over(self.rolling_window))
            .withColumn(
                "pct_positive",
                F.sum("is_positive_return").over(self.rolling_window) / F.col("num_samples"),
            )
            .withColumn(
                "pct_negative",
                F.sum("is_negative_return").over(self.rolling_window) / F.col("num_samples"),
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

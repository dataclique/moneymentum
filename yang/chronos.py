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
    lookback_periods: int
    timeframe: Literal["1h", "1d", "1w"]

    spark = util.get_spark()

    def __post_init__(self) -> None:
        self.symbol_window = W.Window.partitionBy("symbol").orderBy("timestamp")
        self.rolling_window = self.symbol_window.rowsBetween(
            -self.lookback_periods + 1, W.Window.currentRow
        )
        self.has_enough_samples = F.col("count") >= self.lookback_periods

    def with_returns(self, df: DataFrame) -> DataFrame:
        count_df = df.withColumn("count", F.count("close").over(self.symbol_window)).cache()

        if util.DEBUG:
            logger.info("Calculating returns...")
            initial_count = df.select("close").dropna().count()
            ticker_count = len(df.select("ticker").dropna().distinct().collect())
            logger.debug("Initial count: %d; Ticker count: %d", initial_count, ticker_count)

            count_count = count_df.select("count").dropna().count()
            assert (
                count_count == initial_count
            ), f"Count column count ({count_count}) should match initial count ({initial_count})"
            logger.debug("Count column count (%d) check passed.", count_count)

        return_df = count_df.withColumn(
            "log_return",
            F.log(F.col("close") / F.lag("close").over(self.symbol_window)),
        )

        if util.DEBUG:
            return_count = return_df.select("log_return").dropna().count()
            assert 0 < return_count < initial_count, (
                f"Return column count ({return_count})"
                f"should satisfy 0 < {return_count} < {initial_count}"
            )
            logger.debug("Return column count (%d) check passed.", return_count)

        rolling_cum_df = return_df.withColumn(
            "cum_return",
            F.when(
                self.has_enough_samples,
                F.exp(F.sum("log_return").over(self.rolling_window)) - 1,
            ),
        )

        if util.DEBUG:
            rolling_cum_count = rolling_cum_df.select("cum_return").dropna().count()
            assert 0 < rolling_cum_count < return_count, (
                f"Rolling cumulative return column count ({rolling_cum_count})"
                f"should satisfy 0 < {rolling_cum_count} < {return_count}"
            )
            logger.debug(
                "Rolling cumulative return column count (%d) check passed.", rolling_cum_count
            )

        return rolling_cum_df

    def with_volatility(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating volatility...")

        if self.timeframe == "1h":
            annualization_factor = 365 * 24
        elif self.timeframe == "1d":
            annualization_factor = 365
        elif self.timeframe == "1w":
            annualization_factor = 52

        return df.withColumn(
            "stddev",
            F.stddev(F.col("log_return")).over(self.rolling_window),
        ).withColumn(
            "annualized_volatility",
            F.col("stddev") * F.sqrt(F.lit(annualization_factor)),
        )

    def with_min_max(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating min/max...")

        max_min_df = df.withColumn(
            "max",
            F.when(
                self.has_enough_samples,
                F.max("high").over(self.rolling_window),
            ),
        ).withColumn(
            "min",
            F.when(
                self.has_enough_samples,
                F.min("low").over(self.rolling_window),
            ),
        )

        if util.DEBUG:
            min_count = max_min_df.select("min").dropna().count()
            max_count = max_min_df.select("max").dropna().count()
            assert min_count == max_count, (
                f"Should be: min column count ({min_count})" f" == max column count ({max_count})"
            )
            logger.debug("Max/min column counts (%d, %d) check passed.", min_count, max_count)

        return max_min_df

    def with_sma(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating SMA...")

        initial_count = df.select("close").dropna().count()
        sma_df = df.withColumn(
            "sma",
            F.when(self.has_enough_samples, F.avg("close").over(self.rolling_window)),
        )

        if util.DEBUG:
            sma_count = sma_df.select("sma").dropna().count()
            assert (
                0 < sma_count < initial_count
            ), f"SMA column count ({sma_count}) should satisfy 0 < {sma_count} < {initial_count}"
            logger.debug("SMA column count (%d) check passed.", sma_count)

        mean_df = sma_df.withColumn(
            "mean_return",
            F.when(self.has_enough_samples, F.avg("log_return").over(self.rolling_window)),
        )

        if util.DEBUG:
            mean_count = mean_df.select("mean_return").dropna().count()
            assert (
                mean_count == sma_count
            ), f"Mean return column count ({mean_count}) == SMA column count ({sma_count})"
            logger.debug("Mean return column count (%d) check passed.", mean_count)

        stddev_df = mean_df.withColumn(
            "price_stddev",
            F.when(self.has_enough_samples, F.stddev("close").over(self.rolling_window)),
        ).withColumn("return_stddev", F.stddev("log_return").over(self.rolling_window))

        if util.DEBUG:
            stddev_count = stddev_df.select("price_stddev", "return_stddev").dropna().count()
            assert (
                stddev_count == mean_count
            ), f"Price stddev column count ({stddev_count}) should equal {mean_count}"
            logger.debug("Price stddev column count (%d) check passed.", stddev_count)

        return stddev_df

    def with_zscore(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating zscore...")
        price_zscore = (F.col("close") - F.col("sma")) / F.col("price_stddev")
        zscore_df = df.withColumn("price_zscore", price_zscore)

        if util.DEBUG:
            stddev_count = zscore_df.select("stddev").dropna().count()
            price_zscore_count = zscore_df.select("price_zscore").dropna().count()
            assert price_zscore_count <= stddev_count, (
                f"Price zscore count ({price_zscore_count}) should be less than"
                f" stddev count ({stddev_count})"
            )
            logger.debug(
                "Z-score column counts (%d, %d) check passed.", stddev_count, price_zscore_count
            )

        return zscore_df

    def with_beta(
        self, df: DataFrame, return_col: str = "log_return", index_returns: DataFrame = None
    ) -> DataFrame:
        logger.info("Calculating beta...")

        # Get BTC returns
        index_returns = (
            df.filter(F.col("ticker") == "BTC").select(F.col("timestamp"), F.col("log_return"))
            if index_returns is None
            else index_returns
        ).withColumnRenamed("log_return", "index_return")

        # Join BTC returns with all symbols
        joined_df = df.join(index_returns, "timestamp", "left")

        # Calculate rolling covariance and variance
        return (
            joined_df.withColumn("count", F.count(return_col).over(self.rolling_window))
            .withColumn(
                "covariance",
                F.covar_pop(return_col, "index_return").over(self.rolling_window),
            )
            .withColumn("beta", F.col("covariance") / (F.col("stddev") ** 2))
            .drop("index_return")
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

    def with_sharpe(self, df: DataFrame, risk_free: float = 0.0) -> DataFrame:
        logger.info("Calculating sharpe...")

        if self.timeframe == "1h":
            annualization_factor = 365 * 24
        elif self.timeframe == "1d":
            annualization_factor = 365
        elif self.timeframe == "1w":
            annualization_factor = 52

        df_annualized_return = df.withColumn(
            "annualized_return", F.exp(F.col("mean_return") * annualization_factor) - 1
        )

        return df_annualized_return.withColumn(
            "sharpe", (F.col("annualized_return") - risk_free) / F.col("annualized_volatility")
        )

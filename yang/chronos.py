import logging
from dataclasses import dataclass

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql import window as W

from yang import util
from yang.util import Timeframe, TimeframeConfig

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


@dataclass
class Chronos:
    timeframe: Timeframe
    config: TimeframeConfig

    spark = util.get_spark()

    def __post_init__(self) -> None:
        self.symbol_window = W.Window.partitionBy("symbol").orderBy("timestamp")
        self.rolling_window = self.symbol_window.rowsBetween(
            -self.config["lookback_periods"] + 1, W.Window.currentRow
        )
        self.has_enough_samples = F.col("count") >= self.config["lookback_periods"]

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

        return df.withColumn(
            "stddev",
            F.stddev(F.col("log_return")).over(self.rolling_window),
        ).withColumn(
            "annualized_volatility",
            F.col("stddev") * F.sqrt(F.lit(self.config["annualized_factor"])),
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
            assert (
                min_count == max_count
            ), f"Should be: min column count ({min_count}) == max column count ({max_count})"
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
        self,
        df: DataFrame,
        return_col: str = "log_return",
        index_returns: DataFrame | None = None,
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

        initial_count = joined_df.select(return_col).dropna().count()

        beta_df = (
            joined_df.withColumn("count", F.count(return_col).over(self.rolling_window))
            .withColumn(
                "covariance",
                F.covar_pop(return_col, "index_return").over(self.rolling_window),
            )
            .withColumn("beta", F.col("covariance") / (F.col("stddev") ** 2))
            .drop("index_return")
        )

        if util.DEBUG:
            beta_count = beta_df.select("beta").dropna().count()
            assert 0 < beta_count <= initial_count, (
                f"Beta column count ({beta_count}) "
                f"should satisfy 0 < {beta_count} <= {initial_count}"
            )
            logger.debug("Beta column count (%d) check passed.", beta_count)

        return beta_df

    def with_information_discreteness(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating information discreteness...")

        initial_count = df.select("log_return").dropna().count()

        id_df = (
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

        if util.DEBUG:
            id_count = id_df.select("information_discreteness").dropna().count()
            assert 0 < id_count < initial_count, (
                f"Information discreteness column count ({id_count}) "
                f"should satisfy 0 < {id_count} < {initial_count}"
            )
            logger.debug("Information discreteness column count (%d) check passed.", id_count)

        return id_df

    def with_sharpe(self, df: DataFrame, risk_free: float = 0.0) -> DataFrame:
        logger.info("Calculating sharpe...")

        df_annualized_return = df.withColumn(
            "annualized_return", F.exp(F.col("mean_return") * self.config["annualized_factor"]) - 1
        )

        return df_annualized_return.withColumn(
            "sharpe", (F.col("annualized_return") - risk_free) / F.col("annualized_volatility")
        )

    def with_sortino(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating sortino...")

        above_mar_df = df.withColumn(
            "log_return_above_mar", F.col("log_return") - self.config["min_acceptable_return"]
        )

        squared_negative_df = above_mar_df.withColumn(
            "negative_squared",
            F.when(F.col("log_return_above_mar") < 0, F.col("log_return_above_mar") ** 2).otherwise(
                0
            ),
        )

        sum_negative_squared_df = squared_negative_df.withColumn(
            "sum_negative_squared",
            F.when(self.has_enough_samples, F.sum("negative_squared").over(self.rolling_window)),
        )

        count_observations_df = sum_negative_squared_df.withColumn(
            "count_observations",
            F.when(
                self.has_enough_samples,
                F.count("log_return_above_mar").over(self.rolling_window),
            ),
        )

        downside_deviation_df = count_observations_df.withColumn(
            "downside_variance", F.col("sum_negative_squared") / F.col("count_observations")
        ).withColumn(
            # Take the square root to get the downside deviation
            "downside_deviation",
            F.sqrt(F.col("downside_variance")),
        )

        annualized_return_df = downside_deviation_df.withColumn(
            "annualized_return", F.exp(F.col("mean_return") * self.config["annualized_factor"]) - 1
        ).drop(
            "negative_squared", "sum_negative_squared", "count_observations", "downside_variance"
        )

        return annualized_return_df.withColumn(
            "sortino", F.col("annualized_return") / F.col("downside_deviation")
        )

    def with_autocorrelation(self, df: DataFrame) -> DataFrame:
        logger.info("Calculating autocorrelation...")

        lookback_periods = int(self.config["lookback_periods"] / 4)
        rolling_window = self.symbol_window.rowsBetween(-lookback_periods + 1, W.Window.currentRow)

        return df.withColumn(
            "autocorrelation",
            F.corr("log_return", F.lag("log_return").over(self.symbol_window)).over(rolling_window),
        )

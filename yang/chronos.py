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
    """
    Time series analysis engine for calculating technical indicators and risk metrics.

    Chronos uses PySpark to efficiently compute rolling window calculations across
    multiple cryptocurrency assets. It calculates returns, volatility, momentum indicators,
    risk-adjusted returns (Sharpe, Sortino), autocorrelation, beta coefficients, and more.

    Attributes:
        timeframe: Trading timeframe (e.g., "15m", "1h", "4h", "1d")
        config: Timeframe-specific configuration including lookback periods and
            annualization factors
        spark: Shared PySpark session for distributed computation
        symbol_window: Window partitioned by symbol for per-asset calculations
        rolling_window: Rolling window for time-series metrics over lookback periods
        market_window: Window for market-wide calculations (e.g., BTC index variance)
    """

    timeframe: Timeframe
    config: TimeframeConfig

    spark = util.get_spark()

    def __post_init__(self) -> None:
        """Initialize PySpark window specifications for rolling calculations."""
        self.symbol_window = W.Window.partitionBy("symbol").orderBy("timestamp")
        self.rolling_window = self.symbol_window.rowsBetween(
            -self.config["lookback_periods"] + 1, W.Window.currentRow
        )
        self.market_window = W.Window.orderBy("timestamp").rowsBetween(
            -self.config["lookback_periods"] + 1, W.Window.currentRow
        )
        self.has_enough_samples = F.col("count") >= self.config["lookback_periods"]

    def with_returns(self, df: DataFrame) -> DataFrame:
        """
        Calculate log returns and cumulative returns over rolling windows.

        Args:
            df: DataFrame with OHLCV data (must include 'close' and 'timestamp' columns)

        Returns:
            DataFrame with added columns:
                - count: Number of observations per symbol
                - log_return: Natural log of price return (log(close_t / close_{t-1}))
                - cum_return: Cumulative return over lookback period (exp(sum(log_returns)) - 1)
        """
        count_df = df.withColumn("count", F.count("close").over(self.symbol_window)).cache()

        if util.DEBUG:
            logger.info("Calculating returns...")
            initial_count = df.select("close").dropna().count()
            ticker_count = len(df.select("ticker").dropna().distinct().collect())
            logger.debug("Initial count: %d; Ticker count: %d", initial_count, ticker_count)

            count_count = count_df.select("count").dropna().count()
            assert count_count == initial_count, (
                f"Count column count ({count_count}) should match initial count ({initial_count})"
            )
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

    def with_all_features(self, df: DataFrame, index_returns: DataFrame | None = None) -> DataFrame:
        """
        Calculate all technical indicators and risk metrics in a single optimized pipeline.

        This is the primary method for generating comprehensive analysis. It chains all
        calculations (returns, volatility, Sharpe, Sortino, autocorrelation, beta, etc.)
        into one Spark DataFrame operation tree for maximum performance.

        Calculation stages:
            1. Base metrics: count, log_return
            2. Rolling metrics: cum_return, volatility, SMA, standard deviations
            3. Min/max price ranges
            4. Z-score normalization
            5. Sharpe ratio (risk-adjusted return)
            6. Information discreteness (directional momentum measure)
            7. Sortino ratio (downside risk-adjusted return)
            8. Autocorrelation (momentum persistence)
            9. Beta coefficient (market correlation)

        Args:
            df: DataFrame with OHLCV data (columns: timestamp, ticker, open, high, low, close,
                volume)
            index_returns: Optional pre-calculated index (BTC) returns. If None, extracted from
                df.

        Returns:
            DataFrame with all calculated metrics including:
                - Returns: log_return, cum_return, annualized_return
                - Volatility: stddev, annualized_volatility, price_stddev, return_stddev
                - Moving averages: sma, mean_return
                - Price metrics: min, max, price_zscore
                - Risk metrics: sharpe, sortino, information_discreteness
                - Correlation: autocorrelation, beta, covariance
                - Intermediate: downside_deviation

        Note:
            Metrics are only calculated when enough samples exist (>= lookback_periods).
            This prevents incomplete calculations in early periods.
        """
        logger.info("Starting building working tree of all metrics...")

        # --- 1. Base metrics and "enough samples" ---
        # Calculate count and log_return at the beginning
        df_transformed = df.withColumn(
            "count", F.count("close").over(self.symbol_window)
        ).withColumn(
            "log_return",
            F.log(F.col("close") / F.lag("close").over(self.symbol_window)),
        )

        has_enough_samples_expr = F.col("count") >= self.config["lookback_periods"]

        if util.DEBUG:
            initial_count = df.select("close").dropna().count()
            ticker_count = df.select("ticker").distinct().count()
            logger.debug("Initial count: %d; Ticker count: %d", initial_count, ticker_count)

        # --- 2. Metrics dependent on log_return and rolling_window ---
        logger.info("Building cumulative return, volatility, SMA, and standard deviations...")
        df_transformed = df_transformed.withColumns(
            {
                "cum_return": F.when(
                    has_enough_samples_expr,
                    F.exp(F.sum("log_return").over(self.rolling_window)) - 1,
                ),
                "stddev": F.stddev(F.col("log_return")).over(self.rolling_window),
                "annualized_volatility": F.col("stddev")
                * F.sqrt(F.lit(self.config["annualized_factor"])),
                "sma": F.when(has_enough_samples_expr, F.avg("close").over(self.rolling_window)),
                "mean_return": F.when(
                    has_enough_samples_expr, F.avg("log_return").over(self.rolling_window)
                ),
                "price_stddev": F.when(
                    has_enough_samples_expr, F.stddev("close").over(self.rolling_window)
                ),
                "return_stddev": F.stddev("log_return").over(self.rolling_window),
            }
        )

        # --- 3. Min/Max (depends on has_enough_samples) ---
        logger.info("Building min/max...")
        df_transformed = df_transformed.withColumns(
            {
                "max": F.when(has_enough_samples_expr, F.max("high").over(self.rolling_window)),
                "min": F.when(has_enough_samples_expr, F.min("low").over(self.rolling_window)),
            }
        )

        # --- 4. Z-score (depends on sma and price_stddev) ---
        logger.info("Building zscore...")
        df_transformed = df_transformed.withColumn(
            "price_zscore", (F.col("close") - F.col("sma")) / F.col("price_stddev")
        )

        # --- 5. Sharpe (depends on mean_return and annualized_volatility) ---
        logger.info("Building sharpe...")
        df_transformed = df_transformed.withColumn(
            "annualized_return", F.exp(F.col("mean_return") * self.config["annualized_factor"]) - 1
        ).withColumn(
            "sharpe",
            (F.col("annualized_return") - self.config.get("risk_free_rate", 0.0))
            / F.col("annualized_volatility"),
        )

        # --- 6. Information Discreteness (depends on cum_return, log_return, num_samples) ---
        logger.info("Building information discreteness...")
        df_transformed = (
            df_transformed.withColumns(
                {
                    "return_sign": F.signum(F.col("cum_return")),
                    "is_positive_return": F.when(F.col("log_return") > 0, 1).otherwise(0),
                    "is_negative_return": F.when(F.col("log_return") < 0, 1).otherwise(0),
                    "num_samples": F.count("log_return").over(self.rolling_window),
                }
            )
            .withColumns(
                {
                    "pct_positive": F.sum("is_positive_return").over(self.rolling_window)
                    / F.col("num_samples"),
                    "pct_negative": F.sum("is_negative_return").over(self.rolling_window)
                    / F.col("num_samples"),
                }
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

        # --- 7. Sortino (depends on log_return, mean_return, has_enough_samples) ---
        logger.info("Building sortino...")
        df_transformed = (
            df_transformed.withColumn(
                "log_return_above_mar", F.col("log_return") - self.config["min_acceptable_return"]
            )
            .withColumn(
                "negative_squared",
                F.when(
                    F.col("log_return_above_mar") < 0, F.col("log_return_above_mar") ** 2
                ).otherwise(0),
            )
            .withColumn(
                "sum_negative_squared",
                F.when(
                    has_enough_samples_expr, F.sum("negative_squared").over(self.rolling_window)
                ),
            )
            .withColumn(
                "count_observations",
                F.when(
                    has_enough_samples_expr,
                    F.count("log_return_above_mar").over(self.rolling_window),
                ),
            )
            .withColumn(
                "downside_variance", F.col("sum_negative_squared") / F.col("count_observations")
            )
            .withColumn(
                "downside_deviation",
                F.sqrt(F.col("downside_variance")),
            )
            .withColumn("sortino", F.col("annualized_return") / F.col("downside_deviation"))
            .drop(
                "negative_squared",
                "sum_negative_squared",
                "count_observations",
                "downside_variance",
                "log_return_above_mar",
            )
        )

        # --- 8. Autocorrelation (requires another window) ---
        logger.info("Building autocorrelation...")
        lookback_periods_corr = int(self.config["lookback_periods"] / 4)
        rolling_window_corr = self.symbol_window.rowsBetween(
            -lookback_periods_corr + 1, W.Window.currentRow
        )
        df_transformed = df_transformed.withColumn(
            "autocorrelation",
            F.corr("log_return", F.lag("log_return").over(self.symbol_window)).over(
                rolling_window_corr
            ),
        )

        # --- 9. Beta (requires Join) ---
        logger.info("Building beta...")

        # Get BTC returns (index returns)
        # We need log_return from df_transformed, and filter for BTC
        index_returns_df = (
            df_transformed.filter(F.col("ticker") == "BTC").select(
                F.col("timestamp"), F.col("log_return")
            )
            if index_returns is None
            else index_returns
        ).withColumnRenamed("log_return", "index_return")

        # Calculate index_variance using the market_window
        # This will operate only on the BTC returns stream.
        index_returns_with_variance = index_returns_df.withColumn(
            "index_variance", F.variance("index_return").over(self.market_window)
        )

        # Join the main df_transformed with the BTC index data (including variance)
        df_transformed = (
            df_transformed.join(F.broadcast(index_returns_with_variance), "timestamp", "left")
            .withColumn(
                "covariance",
                F.covar_pop("log_return", "index_return").over(self.rolling_window),
            )
            .withColumn(
                "beta",
                F.col("covariance") / F.col("index_variance"),
            )
            .drop("index_return", "index_variance")
        )

        logger.info("All metrics tree are built. Starting to calculate...")
        return df_transformed

    def with_volatility(self, df: DataFrame) -> DataFrame:
        """Calculate standard deviation and annualized volatility of returns."""
        logger.info("Calculating volatility...")

        return df.withColumn(
            "stddev",
            F.stddev(F.col("log_return")).over(self.rolling_window),
        ).withColumn(
            "annualized_volatility",
            F.col("stddev") * F.sqrt(F.lit(self.config["annualized_factor"])),
        )

    def with_min_max(self, df: DataFrame) -> DataFrame:
        """Calculate minimum and maximum prices over rolling window."""
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
                f"Should be: min column count ({min_count}) == max column count ({max_count})"
            )
            logger.debug("Max/min column counts (%d, %d) check passed.", min_count, max_count)

        return max_min_df

    def with_sma(self, df: DataFrame) -> DataFrame:
        """Calculate Simple Moving Average and standard deviations."""
        logger.info("Calculating SMA...")

        initial_count = df.select("close").dropna().count()
        sma_df = df.withColumn(
            "sma",
            F.when(self.has_enough_samples, F.avg("close").over(self.rolling_window)),
        )

        if util.DEBUG:
            sma_count = sma_df.select("sma").dropna().count()
            assert 0 < sma_count < initial_count, (
                f"SMA column count ({sma_count}) should satisfy 0 < {sma_count} < {initial_count}"
            )
            logger.debug("SMA column count (%d) check passed.", sma_count)

        mean_df = sma_df.withColumn(
            "mean_return",
            F.when(self.has_enough_samples, F.avg("log_return").over(self.rolling_window)),
        )

        if util.DEBUG:
            mean_count = mean_df.select("mean_return").dropna().count()
            assert mean_count == sma_count, (
                f"Mean return column count ({mean_count}) == SMA column count ({sma_count})"
            )
            logger.debug("Mean return column count (%d) check passed.", mean_count)

        stddev_df = mean_df.withColumn(
            "price_stddev",
            F.when(self.has_enough_samples, F.stddev("close").over(self.rolling_window)),
        ).withColumn("return_stddev", F.stddev("log_return").over(self.rolling_window))

        if util.DEBUG:
            stddev_count = stddev_df.select("price_stddev", "return_stddev").dropna().count()
            assert stddev_count == mean_count, (
                f"Price stddev column count ({stddev_count}) should equal {mean_count}"
            )
            logger.debug("Price stddev column count (%d) check passed.", stddev_count)

        return stddev_df

    def with_zscore(self, df: DataFrame) -> DataFrame:
        """Calculate z-score normalization: (close - sma) / price_stddev."""
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
        """
        Calculate beta coefficient relative to market index (BTC).

        Beta measures an asset's volatility relative to the market. Beta > 1 indicates
        higher volatility than market, Beta < 1 indicates lower volatility.

        Args:
            df: DataFrame with return data
            return_col: Name of return column to use (default: "log_return")
            index_returns: Optional pre-calculated BTC returns. If None, extracted from df.

        Returns:
            DataFrame with added columns:
                - covariance: Covariance between asset and index returns
                - beta: Asset beta coefficient (covariance / index_variance)
                - index_variance: Variance of market index returns
        """
        logger.info("Calculating beta...")

        # Get BTC returns
        index_returns_df = (
            df.filter(F.col("ticker") == "BTC").select(F.col("timestamp"), F.col("log_return"))
            if index_returns is None
            else index_returns
        ).withColumnRenamed("log_return", "index_return")

        index_returns_with_variance = index_returns_df.withColumn(
            "index_variance", F.variance("index_return").over(self.market_window)
        )

        # Join BTC returns with all symbols
        joined_df = df.join(index_returns_with_variance, "timestamp", "left")

        initial_count = joined_df.select(return_col).dropna().count()

        beta_df = (
            joined_df.withColumn("count", F.count(F.col(return_col)).over(self.rolling_window))
            .withColumn(
                "covariance",
                F.covar_pop(F.col(return_col), F.col("index_return")).over(self.rolling_window),
            )
            .withColumn(
                "beta",
                F.col("covariance") / F.col("index_variance"),
            )
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
        """
        Calculate information discreteness metric for directional momentum.

        Information discreteness measures the alignment between cumulative return direction
        and the proportion of positive vs negative periods. High values indicate strong
        directional consistency.

        Args:
            df: DataFrame with 'log_return' and 'cum_return' columns

        Returns:
            DataFrame with added column:
                - information_discreteness: Directional momentum consistency metric
                  Formula: sign(cum_return) * (pct_negative - pct_positive)
        """
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
        """Calculate Sharpe ratio: (annualized_return - risk_free) / volatility."""
        logger.info("Calculating sharpe...")

        df_annualized_return = df.withColumn(
            "annualized_return", F.exp(F.col("mean_return") * self.config["annualized_factor"]) - 1
        )

        return df_annualized_return.withColumn(
            "sharpe", (F.col("annualized_return") - risk_free) / F.col("annualized_volatility")
        )

    def with_sortino(self, df: DataFrame) -> DataFrame:
        """
        Calculate Sortino ratio for downside risk-adjusted returns.

        Sortino ratio is similar to Sharpe but only penalizes downside volatility,
        making it more appropriate for asymmetric return distributions.

        Args:
            df: DataFrame with 'log_return', 'mean_return', and config-defined min_acceptable_return

        Returns:
            DataFrame with added columns:
                - annualized_return: Annualized return from mean log returns
                - downside_deviation: Standard deviation of returns below MAR
                - sortino: Sortino ratio (annualized_return / downside_deviation)
        """
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
        """Calculate autocorrelation: correlation between returns and lagged returns."""
        logger.info("Calculating autocorrelation...")

        lookback_periods = int(self.config["lookback_periods"] / 4)
        rolling_window = self.symbol_window.rowsBetween(-lookback_periods + 1, W.Window.currentRow)

        return df.withColumn(
            "autocorrelation",
            F.corr("log_return", F.lag("log_return").over(self.symbol_window)).over(rolling_window),
        )

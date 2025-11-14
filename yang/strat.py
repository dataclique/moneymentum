import logging
from dataclasses import dataclass

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql import window as W

from yang import util
from yang.chronos import Chronos
from yang.util import Timeframe, TimeframeConfig

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


@dataclass
class Strategy:
    """
    Trading strategy that generates signals based on momentum and mean reversion.

    This strategy combines autocorrelation (momentum) and SMA deviation (mean reversion)
    to predict future returns. It ranks assets and creates long/short portfolios with
    beta-adjusted position sizing.

    Attributes:
        timeframe: Trading timeframe (e.g., "15m", "1h", "4h", "1d")
        config: Timeframe-specific configuration with lookback periods and token count
        leverage: Maximum portfolio leverage (e.g., 3.0 for 3x leverage)
        starting_equity: Base equity for position sizing in USD
        min_position_size: Minimum position size in USD (smaller positions filtered out)
    """

    timeframe: Timeframe
    config: TimeframeConfig

    leverage: float
    starting_equity: float
    min_position_size: float

    def generate_analysis_optimized(self, candles_df: DataFrame) -> DataFrame:
        """
        Generate comprehensive analysis using optimized single-pass calculation.

        This method uses the optimized `with_all_features` pipeline for maximum performance.

        Args:
            candles_df: DataFrame with OHLCV data (timestamp, ticker, open, high, low, close,
                volume)

        Returns:
            DataFrame with all calculated technical indicators and risk metrics
        """
        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, config=self.config)
        return chronos.with_all_features(candles_df)

    def generate_analysis(self, candles_df: DataFrame) -> DataFrame:
        """
        Generate analysis using sequential transformation pipeline.

        This method chains individual Chronos transformations. In DEBUG mode, it calculates
        all metrics. In production mode, it calculates only essential metrics for performance.

        Args:
            candles_df: DataFrame with OHLCV data (timestamp, ticker, open, high, low, close,
                volume)

        Returns:
            DataFrame with calculated metrics:
                - DEBUG mode: All metrics (returns, volatility, Sharpe, Sortino, beta, etc.)
                - Production mode: Essential metrics (returns, volatility, autocorrelation, SMA,
                    beta)
        """
        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, config=self.config)

        return (
            candles_df.transform(chronos.with_returns)
            .cache()
            .transform(chronos.with_autocorrelation)
            .transform(chronos.with_volatility)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .transform(chronos.with_information_discreteness)
            .transform(chronos.with_sharpe)
            .transform(chronos.with_sortino)
            .drop("count", "symbol", "open", "high", "low", "annualized_return")
            if util.DEBUG
            else candles_df.transform(chronos.with_returns)
            .cache()
            .transform(chronos.with_volatility)
            .transform(chronos.with_autocorrelation)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .drop("count", "open", "high", "low")
        )

    def generate_picks(self, analysis_df: DataFrame) -> DataFrame:
        """
        Generate trading positions from analysis data with beta-adjusted sizing.

        This method implements a hybrid momentum/mean-reversion strategy:
        1. Predicted return = autocorr_weight * mean_return + (1-autocorr_weight) * sma_deviation
        2. Rank assets by predicted return
        3. Long top N assets, short bottom N assets (N = config.n_tokens)
        4. Adjust position sizes by 1/beta to normalize market exposure
        5. Apply leverage constraint and filter positions below minimum size

        Position sizing formula:
            - Raw weight = predicted_return / beta
            - Normalized weight = (raw_weight * leverage) / sum(abs(raw_weights))
            - Position size = normalized_weight * starting_equity
            - Filtered if abs(position_size) < min_position_size

        Args:
            analysis_df: DataFrame from generate_analysis with calculated metrics

        Returns:
            DataFrame with trading positions containing:
                - timestamp: Time of signal
                - ticker: Asset symbol
                - direction: "long" or "short"
                - close: Current price
                - predicted_return: Expected return
                - position_size: Dollar amount to trade
                - position_weight: Portfolio weight (sums to leverage)
                - beta: Asset beta coefficient
        """
        predicted_return = (((1 + F.col("autocorrelation")) / 2) * (F.col("mean_return"))) + (
            ((1 - F.col("autocorrelation")) / 2) * (F.col("sma") - F.col("close")) / F.col("close")
        )

        ranking_col = F.col("predicted_return")
        window_spec = W.Window.partitionBy("timestamp").orderBy(ranking_col)
        return (
            analysis_df.withColumn("predicted_return", predicted_return)
            .filter(ranking_col.isNotNull())
            .withColumn("rank", F.row_number().over(window_spec.orderBy(ranking_col.desc())))
            .withColumn("reverse_rank", F.row_number().over(window_spec))
            .withColumn(
                "direction",
                F.when(F.col("rank") <= F.lit(self.config["n_tokens"]), "long").otherwise(
                    F.when(F.col("reverse_rank") <= F.lit(self.config["n_tokens"]), "short")
                ),
            )
            .withColumn(
                "position_weight",
                F.when(F.col("direction") == "long", F.col("predicted_return"))
                .when(F.col("direction") == "short", -F.col("predicted_return"))
                .otherwise(0),
            )
            .withColumn(
                "position_weight",
                F.when(F.col("beta") > 0, F.col("position_weight") / F.col("beta")).otherwise(
                    F.col("position_weight") / (-F.col("beta"))
                ),
            )
            .withColumn("position_size", F.col("position_weight") * F.lit(self.starting_equity))
            .withColumn(
                "position_weight",
                F.col("position_size")
                * F.lit(self.leverage)
                / F.sum(F.abs(F.col("position_size"))).over(W.Window.partitionBy("timestamp")),
            )
            .withColumn("position_size", F.col("position_weight") * F.lit(self.starting_equity))
            .withColumn(
                "position_size",
                F.when(F.abs(F.col("position_size")) < F.lit(self.min_position_size), 0).otherwise(
                    F.col("position_size")
                ),
            )
            .withColumn(
                "direction", F.when(F.col("position_size") == 0, None).otherwise(F.col("direction"))
            )
            .select(
                F.col("timestamp"),
                F.col("ticker"),
                F.col("direction"),
                F.col("close"),
                F.col("predicted_return"),
                F.col("position_size"),
                F.col("position_weight"),
                F.col("beta"),
            )
            .filter(F.col("direction").isNotNull())
        )

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
    timeframe: Timeframe
    config: TimeframeConfig

    leverage: float
    starting_equity: float
    min_position_size: float

    def generate_analysis(self, candles_df: DataFrame) -> DataFrame:
        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, config=self.config)
        return (
            candles_df.transform(chronos.with_returns)
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
            .transform(chronos.with_volatility)
            .transform(chronos.with_autocorrelation)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .drop("count", "open", "high", "low")
        )

    def generate_picks(self, analysis_df: DataFrame) -> DataFrame:
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

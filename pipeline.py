import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W

from yang import util
from yang.chronos import Chronos
from yang.dataloader.hyperliquid import HyperliquidDataLoader
from yang.exe import ExecutionEngine
from yang.util import TIMEFRAME_CONFIGS, Timeframe, TimeframeConfig

if __name__ == "__main__":
    util.setup_logging()

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)

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


@dataclass
class Pipeline:
    leverage: float
    starting_equity: float
    min_position_size: float
    config: TimeframeConfig
    spark: SparkSession

    timeframe: Timeframe
    start_date: datetime
    dataloader: HyperliquidDataLoader

    async def run(self) -> DataFrame | None:
        logger.info("Starting pipeline...")
        candles_df = await self.dataloader.get_candles_df()

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, config=self.config)
        analysis_df = (
            candles_df.transform(chronos.with_returns)
            .transform(chronos.with_volatility)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .drop("count", "open", "high", "low", "mean_return")
        )

        ma_potential_return = (F.col("sma") - F.col("close")) / F.col("close")
        ranking_col = F.col("price_zscore")
        window_spec = W.Window.partitionBy("timestamp").orderBy(ranking_col)
        picks_df = (
            analysis_df.withColumn("ma_potential_return", ma_potential_return)
            .filter(ranking_col.isNotNull())
            .withColumn("rank", F.row_number().over(window_spec))
            .withColumn(
                "reverse_rank",
                F.row_number().over(window_spec.orderBy(ranking_col.desc())),
            )
            .withColumn(
                "direction",
                F.when(F.col("rank") <= F.lit(self.config["n_tokens"]), "long").otherwise(
                    F.when(F.col("reverse_rank") <= F.lit(self.config["n_tokens"]), "short")
                ),
            )
            .withColumn(
                "position_weight",
                F.when(F.col("direction") == "long", F.col("ma_potential_return"))
                .when(F.col("direction") == "short", -F.col("ma_potential_return"))
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
                F.col("symbol"),
                F.col("ticker"),
                F.col("direction"),
                F.col("close"),
                F.col("price_zscore"),
                F.col("position_size"),
                F.col("position_weight"),
                F.col("sma"),
                F.col("annualized_volatility"),
                F.col("beta"),
            )
            .filter(F.col("direction").isNotNull())
        )

        latest_row = candles_df.select(F.max("timestamp")).first()
        if latest_row is None:
            logger.error("No latest timestamp found")
            return None

        latest = latest_row[0]
        logger.info("Latest timestamp: %s", latest)
        target_portfolio = (
            picks_df.filter(F.col("timestamp") == F.lit(latest))
            .dropna()
            .select("direction", "symbol", "ticker", "position_size", "price_zscore", "close")
            .cache()
        )

        target_portfolio.show()
        return target_portfolio


async def main() -> None:
    timeframe: Timeframe = "1w"
    spark: SparkSession = util.get_spark()
    config: TimeframeConfig = TIMEFRAME_CONFIGS[timeframe]

    start_date = datetime(2023, 6, 1, tzinfo=timezone.utc).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    min_position_size_usd = 11
    leverage: int = 5

    exe = ExecutionEngine(
        spark=spark,
        leverage=leverage,
        min_position_size_usd=min_position_size_usd,
    )

    async with HyperliquidDataLoader(
        spark=spark,
        timeframe=timeframe,
        start_date=start_date,
        config=config,
        min_leverage=leverage,
    ) as dataloader:
        starting_equity = exe.get_balance()
        pipeline = Pipeline(
            starting_equity=starting_equity,
            spark=spark,
            timeframe=timeframe,
            leverage=float(leverage),
            min_position_size=min_position_size_usd,
            start_date=start_date,
            config=config,
            dataloader=dataloader,
        )

        async def step() -> None:
            try:
                pipeline.starting_equity = exe.get_balance()
                target_portfolio = await pipeline.run()
                if target_portfolio is None:
                    return

                exe.rebalance(target_portfolio)
            except Exception:
                logger.exception("Error in step")

        while True:
            await step()


if __name__ == "__main__":
    asyncio.run(main())

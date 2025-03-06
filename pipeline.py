import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T

from yang import util
from yang.dataloader.hyperliquid import HyperliquidDataLoader
from yang.exe import ExecutionEngine
from yang.strat import Strategy
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
class TradingPipeline:
    leverage: float
    starting_equity: float
    min_position_size: float
    config: TimeframeConfig
    spark: SparkSession

    timeframe: Timeframe
    start_date: datetime

    dataloader: HyperliquidDataLoader
    strategy: Strategy

    async def run(self) -> DataFrame | None:
        logger.info("Running the pipeline...")
        logger.info("Starting pipeline...")

        candles_df = await self.dataloader.get_candles_df()

        if util.DEBUG:
            logger.info("Candles DataFrame:")
            candles_df.show(truncate=False)

        analysis_df = self.strategy.generate_analysis(candles_df)
        picks_df = self.strategy.generate_picks(analysis_df)
        latest_row = candles_df.select(F.max("timestamp")).first()
        if latest_row is None:
            logger.error("No latest timestamp found")
            return None

        latest = latest_row[0]
        logger.info("Latest timestamp: %s", latest)
        target_portfolio = picks_df.filter(F.col("timestamp") == F.lit(latest)).dropna().cache()

        logger.info("Target portfolio:")
        target_portfolio.show()
        return target_portfolio


async def main() -> None:
    timeframe: Timeframe = "15m"
    spark: SparkSession = util.get_spark()
    config: TimeframeConfig = TIMEFRAME_CONFIGS[timeframe]

    leverage: int = 5
    min_position_size_usd = 11
    start_date = datetime(2023, 6, 1, tzinfo=timezone.utc).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )

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
        kwargs = dict(
            spark=spark,
            timeframe=timeframe,
            config=config,
            leverage=float(leverage),
            starting_equity=exe.get_balance(),
            min_position_size=min_position_size_usd,
            start_date=start_date,
            dataloader=dataloader,
        )

        strategy = Strategy(**kwargs)
        pipeline = TradingPipeline(**kwargs, strategy=strategy)

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

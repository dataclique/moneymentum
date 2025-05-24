import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Tuple
from pyspark.sql import DataFrame

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import window as W

from yang import util
from yang.dataloader.hyperliquid import HyperliquidDataLoader
from yang.util import TIMEFRAME_CONFIGS, Timeframe, TimeframeConfig

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


@dataclass
class SMACrossoverAnalyzer:
    lookback_periods: int
    spark: SparkSession
    timeframe: Timeframe
    config: TimeframeConfig
    start_date: datetime
    dataloader: HyperliquidDataLoader

    def calculate_sma_crossovers(self, candles_df: DataFrame) -> list[tuple[str, int]]:
        """
        Calculate the number of times price crossed SMA for each token.
        Returns a list of (token, crossover_count) tuples sorted by crossover count.
        """

        rolling_window = W.Window.partitionBy("symbol").orderBy("timestamp").rowsBetween(-self.config["lookback_periods"] + 1, W.Window.currentRow)
        df_with_sma = candles_df.withColumn(
            "sma",
            F.avg("close").over(rolling_window)
        )

        df_with_crosses = df_with_sma.withColumn(
            "prev_close",
            F.lag("close").over(W.Window.partitionBy("symbol").orderBy("timestamp"))
        ).withColumn(
            "prev_sma",
            F.lag("sma").over(W.Window.partitionBy("symbol").orderBy("timestamp"))
        ).withColumn(
            "cross_up",
            F.when(
                (F.col("close") > F.col("sma")) & (F.col("prev_close") <= F.col("prev_sma")),
                1
            ).otherwise(0)
        ).withColumn(
            "cross_down",
            F.when(
                (F.col("close") < F.col("sma")) & (F.col("prev_close") >= F.col("prev_sma")),
                1
            ).otherwise(0)
        )

        token_crosses = df_with_crosses.groupBy("symbol").agg(
            (F.sum("cross_up") + F.sum("cross_down")).alias("total_crosses")
        ).orderBy(F.col("total_crosses").desc())

        return [(row["symbol"], row["total_crosses"]) for row in token_crosses.collect()]

    async def analyze(self) -> list[tuple[str, int]]:
        """
        Main analysis function that fetches data and calculates SMA crossovers.
        """
        logger.info("Starting SMA crossover analysis...")
        
        candles_df = await self.dataloader.get_candles_df()
        
        crossover_results = self.calculate_sma_crossovers(candles_df)
        
        # Log results
        logger.info("SMA Crossover Analysis Results:")
        for token, crosses in crossover_results:
            logger.info(f"{token}: {crosses} crosses")
            
        return crossover_results


async def main() -> None:
    spark = util.get_spark()
    timeframe: Timeframe = "1h"
    config = TIMEFRAME_CONFIGS[timeframe]
    
    lookback_periods = 20
    start_date = datetime(2023, 6, 1, tzinfo=timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    
    async with HyperliquidDataLoader(
        spark=spark,
        timeframe=timeframe,
        start_date=start_date,
        config=config,
        min_leverage=1,
    ) as dataloader:
        analyzer = SMACrossoverAnalyzer(
            lookback_periods=lookback_periods,
            spark=spark,
            timeframe=timeframe,
            config=config,
            start_date=start_date,
            dataloader=dataloader
        )
        
        results = await analyzer.analyze()
        
        print("\nTop 10 tokens with most SMA crosses:")
        for token, crosses in results[:10]:
            print(f"{token}: {crosses} crosses")


if __name__ == "__main__":
    util.setup_logging()
    import asyncio
    asyncio.run(main()) 
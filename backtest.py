import argparse
import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import window as W

from yang import util
from yang.chronos import Chronos
from yang.dataloader.hyperliquid import HyperliquidDataLoader
from yang.strat import Strategy
from yang.util import TIMEFRAME_CONFIGS, Timeframe, TimeframeConfig

if __name__ == "__main__":
    util.setup_logging()

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


class PipelineRunMode(Enum):
    FULL_BACKTEST = "full_backtest"
    ANALYSIS_ONLY = "analysis_only"
    FETCH_DATA_ONLY = "fetch_data_only"


@dataclass
class BacktestPipeline:
    leverage: float
    starting_equity: float
    min_position_size: float
    config: TimeframeConfig
    spark: SparkSession

    timeframe: Timeframe
    start_date: datetime

    dataloader: HyperliquidDataLoader
    strategy: Strategy

    async def run(self, mode: PipelineRunMode = PipelineRunMode.FULL_BACKTEST) -> None:
        """Run the backtest pipeline.

        Args:
            mode: The mode in which to run the pipeline (e.g., FULL_BACKTEST,
            ANALYSIS_ONLY, FETCH_DATA_ONLY).
        """
        logger.info("Starting pipeline in mode: %s", mode.value)

        _funding_rate_df = await self.dataloader.get_funding_rate_df()

        candles_df = await self.dataloader.get_candles_df()

        if mode == PipelineRunMode.FETCH_DATA_ONLY:
            logger.info(
                """Fetching data complete. Skipping analysis and backtest calculations 
                as mode is FETCH_DATA_ONLY."""
            )
            return

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, config=self.config)
        analysis_df = self.strategy.generate_analysis(candles_df)

        util.save_csv("analysis_df", analysis_df)

        if mode == PipelineRunMode.ANALYSIS_ONLY:
            logger.info(
                "Analysis complete. Skipping backtest calculations as mode is ANALYSIS_ONLY."
            )
            return

        picks_df = self.strategy.generate_picks(analysis_df)

        latest_row = candles_df.select(F.max("timestamp")).first()
        if latest_row is None:
            logger.error("No latest timestamp found")
            return

        latest = latest_row[0]
        logger.info("Latest timestamp: %s", latest)
        latest_df = picks_df.filter(F.col("timestamp") == F.lit(latest)).dropna().cache()

        latest_df.show()
        latest_df.count()

        # Calculate returns for each signal
        next_day_returns = (
            analysis_df.select("timestamp", "ticker", "log_return")
            .withColumn(
                "next_timestamp",
                F.lead("timestamp").over(W.Window.partitionBy("ticker").orderBy("timestamp")),
            )
            .withColumn(
                "next_log_return",
                F.lead("log_return").over(W.Window.partitionBy("ticker").orderBy("timestamp")),
            )
        )

        # Join signals with next day returns and calculate weighted returns
        strategy_returns = (
            picks_df.join(next_day_returns, ["timestamp", "ticker"])
            .withColumn(
                "position_return",
                F.when(F.col("direction") == "long", F.col("next_log_return")).when(
                    F.col("direction") == "short", -F.col("next_log_return")
                ),
            )
            .withColumn(
                "weighted_position_return", F.col("position_return") * F.col("position_weight")
            )
        )

        # Update daily performance calculation to use weighted returns
        daily_performance = (
            strategy_returns.groupBy("timestamp")
            .agg(
                F.count("*").alias("number_of_positions"),
                F.avg("position_return").alias("avg_daily_return"),
                F.stddev("position_return").alias("daily_std"),
                F.sum("weighted_position_return").alias("total_return"),
            )
            .orderBy("timestamp")
        )

        # Calculate strategy metrics
        metrics = daily_performance.agg(
            (F.exp(F.avg("total_return")) - 1).alias("avg_daily_portfolio_return"),
            F.stddev("total_return").alias("portfolio_daily_std"),
            F.countDistinct("timestamp").alias("portfolio_periods"),
            F.sum("number_of_positions").alias("total_positions"),
        )

        # Calculate portfolio beta
        portfolio_returns = (
            strategy_returns.groupBy("timestamp")
            .agg(F.sum("weighted_position_return").alias("log_return"))
            .withColumn("symbol", F.lit("ma_portfolio"))
        )

        index_returns = analysis_df.filter(F.col("ticker") == "BTC").select(
            F.col("timestamp"), F.col("log_return")
        )

        portfolio_beta_df = (
            portfolio_returns.transform(chronos.with_volatility)
            .transform(lambda df: chronos.with_beta(df, index_returns=index_returns))
            .agg(F.avg("beta").alias("portfolio_beta"))
        )

        # Combine metrics
        metrics = metrics.crossJoin(portfolio_beta_df).cache()

        annualized_sharpe = metrics.select(
            (F.col("avg_daily_portfolio_return") * self.config["annualized_factor"]).alias(
                "annualized_return"
            ),
            (F.col("portfolio_daily_std") * F.sqrt(F.lit(self.config["annualized_factor"]))).alias(
                "annual_vol"
            ),
            (F.col("annualized_return") / F.col("annual_vol")).alias("sharpe_ratio"),
        )

        logger.info("Strategy Performance Metrics:")
        metrics.show()
        annualized_sharpe.show()


async def main() -> None:
    parser = argparse.ArgumentParser(description="Run backtest pipeline.")
    parser.add_argument(
        "--mode",
        type=str,
        choices=[mode.value for mode in PipelineRunMode],
        default=PipelineRunMode.FULL_BACKTEST.value,
        help="Pipeline run mode",
    )
    args = parser.parse_args()
    mode = PipelineRunMode(args.mode)

    spark = util.get_spark()
    timeframe: Timeframe = "1h"

    config = TIMEFRAME_CONFIGS[timeframe]

    leverage: int = 5
    starting_equity = 100
    min_position_size_usd = 11
    start_date = datetime(2022, 1, 1, tzinfo=timezone.utc).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )

    async with HyperliquidDataLoader(
        spark=spark,
        timeframe=timeframe,
        start_date=start_date,
        config=config,
        min_leverage=leverage,
    ) as dataloader:
        strategy = Strategy(
            timeframe=timeframe,
            config=config,
            leverage=float(leverage),
            starting_equity=starting_equity,
            min_position_size=min_position_size_usd,
        )

        pipeline = BacktestPipeline(
            spark=spark,
            timeframe=timeframe,
            config=config,
            leverage=float(leverage),
            starting_equity=starting_equity,
            min_position_size=min_position_size_usd,
            start_date=start_date,
            dataloader=dataloader,
            strategy=strategy,
        )

        await pipeline.run(mode=mode)


if __name__ == "__main__":
    asyncio.run(main())

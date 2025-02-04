import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W

from yang import util
from yang.chronos import Chronos
from yang.dataloader.hyperliquid.markets import HyperliquidDataLoaderMarkets, SchemaPerpMarket
from yang.dataloader.hyperliquid.ohlcv import (
    HyperliquidDataLoaderOHLCV,
    Timeframe,
)

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
    reload: bool
    n_tokens: int
    leverage: float
    starting_equity: float
    min_position_size: float

    spark: SparkSession

    timeframe: Timeframe
    lookback_periods: int
    start_date: datetime
    reload_markets: bool = True

    def __post_init__(self) -> None:
        self.loader_markets: HyperliquidDataLoaderMarkets = HyperliquidDataLoaderMarkets(
            spark=self.spark
        )
        self.loader_ohlcv: HyperliquidDataLoaderOHLCV = HyperliquidDataLoaderOHLCV()

    async def get_candles_df(self, timeframe: Timeframe) -> DataFrame:
        logger.debug("Initializing exchange...")
        exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        logger.info("Exchange initialized: %s", exchange)

        # Only last 5000 candles available
        logger.info("Fetching data since: %s", self.start_date)
        since = int(self.start_date.timestamp() * 1000)

        if self.reload_markets:
            markets_df = await self.loader_markets.fetch_markets(exchange=exchange)
        else:
            markets_path = f"{util.DATA_DIR}/markets.csv"
            markets_df = (
                self.spark.read.schema(SchemaPerpMarket).csv(markets_path, header=True).cache()
            )

        symbols = markets_df.select("symbol").rdd.flatMap(lambda x: x).collect()

        candles_file_path = f"{util.DATA_DIR}/ohlcv{timeframe}.csv"
        if Path(candles_file_path).exists():
            existing_df = pd.read_csv(candles_file_path, parse_dates=["timestamp"])
        else:
            existing_df = None

        def get_symbol_start_time(symbol: str) -> int:
            if existing_df is None:
                return since

            symbol_df = existing_df[existing_df["symbol"] == symbol]
            if symbol_df.empty:
                return since

            last_timestamp_ms = int(symbol_df.iloc[-1]["timestamp"].timestamp() * 1000)
            return max(since, last_timestamp_ms)

        ohlcv_tasks = [
            self.loader_ohlcv.fetch_ohlcv(
                exchange, symbol, timeframe, get_symbol_start_time(symbol)
            )
            for symbol in symbols
        ]

        ohlcv_data = [
            candle for candles in await asyncio.gather(*ohlcv_tasks) for candle in candles
        ]

        # TODO: Move funding rate to a separate method
        # funding_rate_data = [rate for rates in funding_rate_results for rate in rates]

        # Normalize timestamps
        # for rate in funding_rate_data:
        #     rate["timestamp"] = normalize_timestamp(rate["timestamp"])

        # Create funding rate lookup map
        # funding_rate_map = {
        #     (rate["symbol"], rate["timestamp"]): rate["funding_rate"] for rate in funding_rate_data  # noqa: E501
        # }

        # Add funding rate to OHLCV data
        # for candle in ohlcv_data:
        #     candle["funding_rate"] = funding_rate_map.get(
        #         (candle["symbol"], candle["timestamp"]), None
        #     )

        pdf = pd.DataFrame(ohlcv_data)
        pdf["timestamp"] = pd.to_datetime(pdf["timestamp"], utc=True)
        pdf["timestamp"] = pdf["timestamp"].dt.tz_localize(None)

        if existing_df is not None:
            existing_df["timestamp"] = pd.to_datetime(existing_df["timestamp"], utc=True)
            existing_df["timestamp"] = existing_df["timestamp"].dt.tz_localize(None)
            combined_df = pd.concat([existing_df, pdf], ignore_index=True)
            combined_df = combined_df.sort_values(by=["timestamp"])
            combined_df = combined_df.drop_duplicates(subset=["timestamp", "symbol"], keep="last")
            ohlcv_df = self.spark.createDataFrame(combined_df, schema=SchemaOHLCV).cache()
        else:
            ohlcv_df = self.spark.createDataFrame(pdf, schema=SchemaOHLCV).cache()

        logger.info("Converted to Spark DataFrame with schema logged.")
        ohlcv_df.printSchema()
        ohlcv_df.show()

        candles_df = ohlcv_df.orderBy("timestamp")
        candles_file_name = f"ohlcv{timeframe}"
        util.save_csv(candles_file_name, candles_df)

        return self.spark.read.schema(SchemaOHLCV).csv(candles_file_path, header=True).cache()

    async def run(self) -> None:
        logger.info("Starting pipeline...")

        candles_df = await self.get_candles_df(timeframe=self.timeframe)

        logger.info("Candles DataFrame:")
        candles_df.show(truncate=False)

        chronos = Chronos(timeframe=self.timeframe, lookback_periods=self.lookback_periods)
        analysis_df = (
            candles_df.transform(chronos.with_returns)
            .transform(chronos.with_volatility)
            .transform(chronos.with_sma)
            .transform(chronos.with_zscore)
            .transform(chronos.with_beta)
            .transform(chronos.with_information_discreteness)
            .transform(chronos.with_sharpe)
            .transform(chronos.with_sortino)
            .drop("count", "symbol", "open", "high", "low", "mean_return", "annualized_return")
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
                F.when(F.col("rank") <= F.lit(self.n_tokens), "long").otherwise(
                    F.when(F.col("reverse_rank") <= F.lit(self.n_tokens), "short")
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

        # Get latest entries
        latest = candles_df.select(F.max("timestamp")).first()[0]
        logger.info("Latest timestamp: %s", latest)
        latest_df = (
            picks_df.filter(F.col("timestamp") == F.lit(latest))
            .dropna()
            .select("direction", "ticker", "position_size", "price_zscore", "close")
            .cache()
        )

        latest_df.show()
        latest_df.count()
        util.save_csv("picks", latest_df)

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

        if self.timeframe == "1w":
            annualized_factor = 52
        elif self.timeframe == "1d":
            annualized_factor = 365
        elif self.timeframe == "1h":
            annualized_factor = 365 * 24

        annualized_sharpe = metrics.select(
            (F.col("avg_daily_portfolio_return") * annualized_factor).alias("annualized_return"),
            (F.col("portfolio_daily_std") * F.sqrt(F.lit(annualized_factor))).alias("annual_vol"),
            (F.col("annualized_return") / F.col("annual_vol")).alias("sharpe_ratio"),
        )

        logger.info("Strategy Performance Metrics:")
        metrics.show()
        annualized_sharpe.show()


if __name__ == "__main__":
    spark = util.get_spark()
    timeframe = "1d"

    # TODO: This is repeated in multiple places. Make it a helper function
    if timeframe == "1w":
        lookback_periods = 52
        n_tokens = 2
    elif timeframe == "1d":
        lookback_periods = 90
        n_tokens = 6
    elif timeframe == "1h":
        lookback_periods = 7 * 24
        n_tokens = 5

    start_date = datetime(2023, 6, 1, tzinfo=timezone.utc).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )

    # Create list of configurations to test
    n_tokens_range = range(2, 9)  # 2 to 8 inclusive
    results = []

    # Run pipeline for each n_tokens value
    logger.info("Running backtest with n_tokens=%d", n_tokens)
    pipeline = Pipeline(
        reload=True,
        spark=spark,
        timeframe=timeframe,
        n_tokens=n_tokens,
        leverage=3.0,
        starting_equity=75.52,
        min_position_size=11,
        start_date=start_date,
        lookback_periods=lookback_periods,
    )
    asyncio.run(pipeline.run())

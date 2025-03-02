import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql import window as W

from yang import util
from yang.chronos import Chronos
from yang.dataloader.hyperliquid.markets import HyperliquidDataLoaderMarkets
from yang.dataloader.hyperliquid.ohlcv import HyperliquidDataLoaderOHLCV
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
    reload: bool
    leverage: float
    starting_equity: float
    min_position_size: float
    config: TimeframeConfig
    spark: SparkSession

    timeframe: Timeframe
    start_date: datetime
    reload_markets: bool = False

    def __post_init__(self) -> None:
        self.loader_markets: HyperliquidDataLoaderMarkets = HyperliquidDataLoaderMarkets(
            spark=self.spark
        )
        self.loader_ohlcv: HyperliquidDataLoaderOHLCV = HyperliquidDataLoaderOHLCV()

    async def get_candles_df(self, timeframe: Timeframe) -> DataFrame:
        logger.debug("Initializing exchange...")

        exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})

        logger.info("Exchange initialized: %s", exchange)
        logger.info("Fetching data since: %s", self.start_date)

        candles_file_path = f"{util.DATA_DIR}/ohlcv{timeframe}.csv"

        since = int(self.start_date.timestamp() * 1000)

        symbols = await self.get_tradable_symbols(exchange)
        existing_df = self.get_existing_df(candles_file_path)

        if existing_df is None:
            tokens_for_markets = set()
            tokens_for_candles = set(symbols)
        else:
            (tokens_for_candles, tokens_for_markets) = self.sort_symbols_by_fetch_method(
                existing_df, since, symbols
            )

        if tokens_for_markets:
            market_data = await exchange.load_markets()
        else:
            market_data = None

        if tokens_for_candles:
            ohlcv_data = await self.load_ohlcv(exchange, tokens_for_candles, existing_df, since)
        else:
            ohlcv_data = None

        candles_df = self.build_df_from_data(
            ohlcv_data, existing_df, tokens_for_markets, market_data
        )

        candles_file_name = f"ohlcv{timeframe}"
        util.save_csv(candles_file_name, candles_df)

        return self.spark.read.schema(SchemaOHLCV).csv(candles_file_path, header=True).cache()

    async def get_tradable_symbols(self, exchange: ccxt.Exchange) -> set:
        markets_df = await self.loader_markets.fetch_markets(
            exchange=exchange, reload=self.reload_markets
        )
        filtered_df = markets_df.filter(~F.col("deprecated"))

        return set(filtered_df.select("symbol").rdd.flatMap(lambda x: x).collect())

    def get_existing_df(self, file_path: str) -> pd.DataFrame | None:
        if Path(file_path).exists():
            return pd.read_csv(file_path, parse_dates=["timestamp"])
        return None

    def get_symbol_start_time(
        self, symbol: str, existing_df: pd.DataFrame | None, since: int
    ) -> int:
        if existing_df is None:
            return since

        symbol_df = existing_df[existing_df["symbol"] == symbol]
        if symbol_df.empty:
            return since

        last_timestamp_ms = int(symbol_df.iloc[-1]["timestamp"].timestamp() * 1000)
        return max(since, last_timestamp_ms)

    def sort_symbols_by_fetch_method(
        self, existing_df: pd.DataFrame, since: int, symbols: set
    ) -> tuple[set, set]:
        current_time_ms = int(time.time() * 1000)
        tokens_for_candles = set()
        tokens_for_markets = set()

        for symbol in symbols:
            last_timestamp_ms = self.get_symbol_start_time(symbol, existing_df, since)
            if current_time_ms - last_timestamp_ms > config["time_in_ms"]:
                tokens_for_candles.add(symbol)
            else:
                tokens_for_markets.add(symbol)

        return tokens_for_candles, tokens_for_markets

    async def load_ohlcv(
        self,
        exchange: ccxt.Exchange,
        tokens_for_candles: set,
        existing_df: pd.DataFrame | None,
        since: int,
    ) -> list[dict[str, Any]]:
        ohlcv_tasks = [
            self.loader_ohlcv.fetch_ohlcv(
                exchange, symbol, timeframe, self.get_symbol_start_time(symbol, existing_df, since)
            )
            for symbol in tokens_for_candles
        ]

        return [candle for candles in await asyncio.gather(*ohlcv_tasks) for candle in candles]

    def build_df_from_data(
        self,
        ohlcv_data: list[dict[str, Any]] | None,
        existing_df: pd.DataFrame | None,
        tokens_for_markets: set | None,
        market_data: dict,
    ) -> DataFrame:
        if ohlcv_data:
            pdf = pd.DataFrame(ohlcv_data)
            pdf["timestamp"] = pd.to_datetime(pdf["timestamp"], utc=True).dt.tz_localize(None)

        # If we have tokens_for_makerts we also have existing_df
        if tokens_for_markets:
            existing_df["timestamp"] = pd.to_datetime(
                existing_df["timestamp"], utc=True
            ).dt.tz_localize(None)
            for symbol in tokens_for_markets:
                mark_px = market_data.get(symbol, {}).get("info", {}).get("markPx")
                if mark_px is not None:
                    latest_index = existing_df[existing_df["symbol"] == symbol][
                        "timestamp"
                    ].idxmax()
                    existing_df.loc[latest_index, "close"] = float(mark_px)

            if ohlcv_data:
                combined_df = pd.concat([existing_df, pdf], ignore_index=True)
                combined_df = combined_df.drop_duplicates(
                    subset=["timestamp", "symbol"], keep="last"
                )
                ohlcv_df = self.spark.createDataFrame(combined_df, schema=SchemaOHLCV).cache()
            else:
                ohlcv_df = self.spark.createDataFrame(existing_df, schema=SchemaOHLCV).cache()
        else:
            existing_df["timestamp"] = pd.to_datetime(
                existing_df["timestamp"], utc=True
            ).dt.tz_localize(None)

            combined_df = pd.concat([existing_df, pdf], ignore_index=True)
            combined_df = combined_df.drop_duplicates(subset=["timestamp", "symbol"], keep="last")
            ohlcv_df = self.spark.createDataFrame(combined_df, schema=SchemaOHLCV).cache()

        logger.info("Converted to Spark DataFrame with schema logged.")
        ohlcv_df.printSchema()
        ohlcv_df.show()

        return ohlcv_df.orderBy("timestamp")

    async def run(self) -> DataFrame:
        logger.info("Starting pipeline...")
        candles_df = await self.get_candles_df(timeframe=self.timeframe)

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

        latest = candles_df.select(F.max("timestamp")).first()[0]
        logger.info("Latest timestamp: %s", latest)
        target_portfolio = (
            picks_df.filter(F.col("timestamp") == F.lit(latest))
            .dropna()
            .select("direction", "symbol", "ticker", "position_size", "price_zscore", "close")
            .cache()
        )

        target_portfolio.show()
        return target_portfolio


if __name__ == "__main__":
    timeframe = "1h"
    spark: SparkSession = util.get_spark()
    config: TimeframeConfig = TIMEFRAME_CONFIGS[timeframe]

    start_date = datetime(2023, 6, 1, tzinfo=timezone.utc).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    min_position_size_usd = 11
    leverage: int = 3

    exe = ExecutionEngine(
        spark=spark,
        leverage=leverage,
        min_position_size_usd=min_position_size_usd,
    )
    pipeline_kwargs = dict(
        reload=True,
        spark=spark,
        timeframe=timeframe,
        leverage=leverage,
        min_position_size=min_position_size_usd,
        start_date=start_date,
        config=config,
    )

    def step() -> None:
        starting_equity = exe.get_balance()
        pipeline = Pipeline(**pipeline_kwargs, starting_equity=starting_equity)
        target_portfolio = asyncio.run(pipeline.run())
        exe.rebalance(target_portfolio)

    # Run once immediately on start
    logger.info("Starting the initial run...")
    step()

    # every_minutes = 10
    # period = timedelta(minutes=every_minutes)
    while True:
        # now = datetime.now(timezone.utc)
        # quantized_minute = now.minute // every_minutes * every_minutes
        # quantized_now = now.replace(minute=quantized_minute, second=0, microsecond=0)
        # until = quantized_now + period

        # sleep_duration = (until - now).total_seconds()
        # logger.info("Sleeping until %s", until.isoformat())
        # time.sleep(sleep_duration)

        step()

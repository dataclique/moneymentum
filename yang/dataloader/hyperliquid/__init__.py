import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
from ccxt import async_support as ccxt  # type: ignore[import-untyped]
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from yang import util
from yang.dataloader.hyperliquid.markets import HyperliquidDataLoaderMarkets
from yang.dataloader.hyperliquid.ohlcv import HyperliquidDataLoaderOHLCV, SchemaOHLCV
from yang.util import Timeframe, TimeframeConfig

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


@dataclass
class HyperliquidDataLoader:
    start_date: datetime
    timeframe: Timeframe
    config: TimeframeConfig
    spark: SparkSession

    def __post_init__(self) -> None:
        self.loader_markets: HyperliquidDataLoaderMarkets = HyperliquidDataLoaderMarkets(
            spark=self.spark
        )
        self.loader_ohlcv: HyperliquidDataLoaderOHLCV = HyperliquidDataLoaderOHLCV()

        logger.debug("Initializing exchange...")
        self.exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        logger.info("Exchange initialized: %s", self.exchange)

    async def get_candles_df(self) -> DataFrame:
        candles_file_path = f"{util.DATA_DIR}/ohlcv{self.timeframe}.csv"

        since = int(self.start_date.timestamp() * 1000)
        symbols = await self.get_tradable_symbols(self.exchange)
        existing_df = self.get_existing_df(candles_file_path)

        (tokens_for_candles, tokens_for_markets) = (
            self.sort_symbols_by_fetch_method(existing_df, since, symbols)
            if existing_df is not None
            else (set(), set(symbols))
        )

        if tokens_for_markets:
            market_data = await self.exchange.load_markets()
        else:
            market_data = None

        if tokens_for_candles:
            ohlcv_data = await self.load_ohlcv(
                self.exchange, tokens_for_candles, existing_df, since
            )
        else:
            ohlcv_data = None

        candles_df = self.build_df_from_data(
            ohlcv_data, existing_df, tokens_for_markets, market_data
        )

        candles_file_name = f"ohlcv{self.timeframe}"
        util.save_csv(candles_file_name, candles_df)

        return self.spark.read.schema(SchemaOHLCV).csv(candles_file_path, header=True).cache()

    async def get_tradable_symbols(self, exchange: ccxt.Exchange) -> set:
        markets_df = await self.loader_markets.fetch_markets(exchange=exchange)
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
            if current_time_ms - last_timestamp_ms > self.config["time_in_ms"]:
                tokens_for_candles.add(symbol)
            else:
                tokens_for_markets.add(symbol)

        return tokens_for_candles, tokens_for_markets

    async def load_ohlcv(
        self,
        tokens_for_candles: set,
        existing_df: pd.DataFrame | None,
        since: int,
    ) -> list[dict[str, Any]]:
        ohlcv_tasks = [
            self.loader_ohlcv.fetch_ohlcv(
                self.exchange,
                symbol,
                self.timeframe,
                self.get_symbol_start_time(symbol, existing_df, since),
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

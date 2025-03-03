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
    min_leverage: int

    async def __aenter__(self):  # noqa: ANN204
        return self

    def __post_init__(self) -> None:
        self.loader_markets: HyperliquidDataLoaderMarkets = HyperliquidDataLoaderMarkets(
            spark=self.spark
        )
        self.loader_ohlcv: HyperliquidDataLoaderOHLCV = HyperliquidDataLoaderOHLCV()

        logger.debug("Initializing exchange...")
        self.exchange = ccxt.hyperliquid({"asyncio_loop": asyncio.get_event_loop()})
        logger.info("Exchange initialized: %s", self.exchange)

    async def __aexit__(self, exc_type, exc_val, exc_tb):  # noqa: ANN001, ANN204
        await self.exchange.close()

    async def get_candles_df(self) -> DataFrame:
        candles_file_path = f"{util.DATA_DIR}/ohlcv{self.timeframe}.csv"

        since = int(self.start_date.timestamp() * 1000)
        symbols = await self.get_tradable_symbols()
        existing_df = self.get_existing_df(candles_file_path)

        (tokens_for_candle_updates, tokens_for_markets) = (
            (set(symbols), set())
            if existing_df is None
            else self.sort_symbols_by_fetch_method(existing_df, since, symbols)
        )

        market_data = await self.exchange.load_markets() if tokens_for_markets else None
        ohlcv_data = (
            await self.exchange.load_ohlcv(tokens_for_candle_updates, since)
            if tokens_for_candle_updates
            else None
        )

        candles_df = self.build_df_from_data(
            ohlcv_data, existing_df, tokens_for_markets, market_data
        )

        candles_file_name = f"ohlcv{self.timeframe}"
        util.save_csv(candles_file_name, candles_df)

        return self.spark.read.schema(SchemaOHLCV).csv(candles_file_path, header=True).cache()

    async def get_tradable_symbols(self) -> set:
        markets_df = await self.loader_markets.fetch_markets(exchange=self.exchange)
        filtered_df = markets_df.filter(~F.col("disable")).filter(
            F.col("maxLeverage") >= F.lit(self.min_leverage)
        )

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

        assert (len(tokens_for_candles) + len(tokens_for_markets)) == len(
            symbols
        ), "Sum of sorted tokens not equal to unsorted set"
        logger.info(
            "Sorted tokens by fetching method:\nBy candles: %s\nBy market: %s",
            len(tokens_for_candles),
            len(tokens_for_markets),
        )

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
        tokens_updated_by_market: set | None,
        market_data: dict,
    ) -> DataFrame:
        def normalize_timestamps(df: pd.DataFrame) -> pd.DataFrame:
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True).dt.tz_localize(None)
            return df

        def update_closes(df: pd.DataFrame, tokens: set, market_data: dict) -> pd.DataFrame:
            for symbol in tokens:
                mark_px = market_data.get(symbol, {}).get("info", {}).get("markPx")
                if mark_px is not None:
                    latest_index = df[df["symbol"] == symbol]["timestamp"].idxmax()
                    df.loc[latest_index, "close"] = float(mark_px)
            return df

        def combine_dfs(df1: pd.DataFrame, df2: pd.DataFrame) -> pd.DataFrame:
            combined_df = pd.concat([df1, df2], ignore_index=True)
            return combined_df.drop_duplicates(subset=["timestamp", "symbol"], keep="last")

        candles_df = normalize_timestamps(pd.DataFrame(ohlcv_data)) if ohlcv_data else None

        if existing_df is not None:
            existing_df = normalize_timestamps(existing_df)
            if tokens_updated_by_market:
                existing_df = update_closes(existing_df, tokens_updated_by_market, market_data)

        final_df = (
            combine_dfs(existing_df, candles_df)
            if existing_df is not None and candles_df is not None
            else existing_df
            if existing_df is not None
            else candles_df
        )

        if final_df is not None:
            ohlcv_df = self.spark.createDataFrame(final_df, schema=SchemaOHLCV).cache()
        else:
            raise Exception("No data fetched and no existing df")

        logger.info("Converted to Spark DataFrame with schema logged.")
        if util.DEBUG:
            ohlcv_df.printSchema()
            ohlcv_df.show()

        return ohlcv_df.orderBy("timestamp")

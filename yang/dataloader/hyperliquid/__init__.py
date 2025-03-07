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
from yang.dataloader.hyperliquid.funding_rates import (
    HyperliquidDataLoaderFundingRates,
    SchemaFUNDINGRATE,
)
from yang.dataloader.hyperliquid.markets import HyperliquidDataLoaderMarkets
from yang.dataloader.hyperliquid.ohlcv import HyperliquidDataLoaderOHLCV, SchemaOHLCV
from yang.util import Timeframe, TimeframeConfig

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


class HyperliquidDataLoaderError(Exception):
    """Base exception class for HyperliquidDataLoader errors."""


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

        self.loader_funding_rate: HyperliquidDataLoaderFundingRates = (
            HyperliquidDataLoaderFundingRates()
        )

        logger.debug("Initializing exchange...")
        self.exchange = ccxt.hyperliquid(
            {
                "asyncio_loop": asyncio.get_event_loop(),
                "timeout": 10000,  # 3 seconds
                "enableRateLimit": True,
                "rateLimit": 20,  # Adjust rate limit if necessary
            }
        )
        logger.info("Exchange initialized: %s", self.exchange)

    async def __aexit__(self, exc_type, exc_val, exc_tb):  # noqa: ANN001, ANN204
        await self.exchange.close()

    async def get_funding_rate_df(self) -> DataFrame:
        funding_rate_file_path = f"{util.DATA_DIR}/funding_rate1h.csv"

        since = int(self.start_date.timestamp() * 1000)
        tradable_symbols = await self.get_tradable_symbols()
        existing_funding_rate_df = self.get_existing_df(funding_rate_file_path)

        funding_rate_data = await self.load_funding_rate(
            set(tradable_symbols), existing_funding_rate_df, since
        )

        funding_rate_df = self.construct_funding_rate_dataframe(
            funding_rate_data, existing_funding_rate_df
        )

        if funding_rate_data:
            funding_rate_file_name = "funding_rate1h"
            util.save_csv(funding_rate_file_name, funding_rate_df)
        else:
            logger.info(
                "No new funding rates found",
            )

        return (
            self.spark.read.schema(SchemaFUNDINGRATE)
            .csv(funding_rate_file_path, header=True)
            .cache()
        )

    async def get_candles_df(self) -> DataFrame:
        ohlcv_file_path = f"{util.DATA_DIR}/ohlcv{self.timeframe}.csv"

        since = int(self.start_date.timestamp() * 1000)
        tradable_symbols = await self.get_tradable_symbols()
        existing_ohlcv_df = self.get_existing_df(ohlcv_file_path)

        (symbols_for_ohlcv_updates, symbols_for_market_updates) = (
            (set(tradable_symbols), set())
            if existing_ohlcv_df is None
            else self.categorize_symbols_by_update_method(
                existing_ohlcv_df, since, tradable_symbols
            )
        )

        market_info = await self.exchange.load_markets() if symbols_for_market_updates else None

        ohlcv_data = (
            await self.load_ohlcv(symbols_for_ohlcv_updates, existing_ohlcv_df, since)
            if symbols_for_ohlcv_updates
            else None
        )

        candles_df = self.construct_ohlcv_dataframe(
            ohlcv_data, existing_ohlcv_df, symbols_for_market_updates, market_info
        )

        candles_file_name = f"ohlcv{self.timeframe}"
        util.save_csv(candles_file_name, candles_df)

        return self.spark.read.schema(SchemaOHLCV).csv(ohlcv_file_path, header=True).cache()

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

    def categorize_symbols_by_update_method(
        self, existing_ohlcv_df: pd.DataFrame, since: int, tradable_symbols: set
    ) -> tuple[set, set]:
        current_time_ms = int(time.time() * 1000)
        symbols_for_ohlcv_updates = set()
        symbols_for_market_updates = set()

        for symbol in tradable_symbols:
            last_timestamp_ms = self.get_symbol_start_time(symbol, existing_ohlcv_df, since)
            if current_time_ms - last_timestamp_ms > self.config["time_in_ms"]:
                symbols_for_ohlcv_updates.add(symbol)
            else:
                symbols_for_market_updates.add(symbol)

        assert (len(symbols_for_ohlcv_updates) + len(symbols_for_market_updates)) == len(
            tradable_symbols
        ), "Sum of sorted tokens not equal to unsorted set"
        logger.info(
            "Sorted tokens by fetching method:\nBy ohlcv: %s\nBy market: %s",
            len(symbols_for_ohlcv_updates),
            len(symbols_for_market_updates),
        )

        return symbols_for_ohlcv_updates, symbols_for_market_updates

    async def load_funding_rate(
        self, symbols: set, existing_funding_rate_df: pd.DataFrame | None, since: int
    ) -> list[dict[str, Any]]:
        funding_rate_tasks = [
            self.loader_funding_rate.fetch_funding_rate_history(
                self.exchange,
                symbol,
                # POPCAT/USDC:USDC --> POPCAT, because funding_rate return only base
                self.get_symbol_start_time(symbol.split("/")[0], existing_funding_rate_df, since),
            )
            for symbol in symbols
        ]

        return [
            funding_rate
            for funding_rates in await asyncio.gather(*funding_rate_tasks)
            for funding_rate in funding_rates
        ]

    async def load_ohlcv(
        self,
        symbols_for_ohlcv_updates: set,
        existing_ohlcv_df: pd.DataFrame | None,
        since: int,
    ) -> list[dict[str, Any]]:
        ohlcv_tasks = [
            self.loader_ohlcv.fetch_ohlcv(
                self.exchange,
                symbol,
                self.timeframe,
                self.get_symbol_start_time(symbol, existing_ohlcv_df, since),
            )
            for symbol in symbols_for_ohlcv_updates
        ]

        return [candle for candles in await asyncio.gather(*ohlcv_tasks) for candle in candles]

    def construct_funding_rate_dataframe(
        self, funding_rate_data: list[dict[str, Any]], existing_funding_rate_df: pd.DataFrame | None
    ) -> DataFrame:
        def normalize_timestamps(df: pd.DataFrame) -> pd.DataFrame:
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True).dt.tz_localize(None)
            return df

        funding_rate_df = (
            normalize_timestamps(pd.DataFrame(funding_rate_data)) if funding_rate_data else None
        )

        if existing_funding_rate_df is not None:
            existing_funding_rate_df = normalize_timestamps(existing_funding_rate_df)

            if funding_rate_df is None:
                final_df = existing_funding_rate_df
            else:
                final_df = pd.concat([existing_funding_rate_df, funding_rate_df], ignore_index=True)
        elif funding_rate_df is not None:
            final_df = funding_rate_df
        else:
            error_message = "No data fetched and no existing df"
            raise HyperliquidDataLoaderError(error_message)

        funding_rate_df_return = self.spark.createDataFrame(
            final_df.drop_duplicates(), schema=SchemaFUNDINGRATE
        ).cache()

        return funding_rate_df_return.orderBy("timestamp")

    def construct_ohlcv_dataframe(
        self,
        ohlcv_records: list[dict[str, Any]] | None,
        existing_ohlcv_df: pd.DataFrame | None,
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

        candles_df = normalize_timestamps(pd.DataFrame(ohlcv_records)) if ohlcv_records else None

        if existing_ohlcv_df is not None:
            existing_ohlcv_df = normalize_timestamps(existing_ohlcv_df)
            if tokens_updated_by_market:
                existing_ohlcv_df = update_closes(
                    existing_ohlcv_df, tokens_updated_by_market, market_data
                )

        final_df = (
            combine_dfs(existing_ohlcv_df, candles_df)
            if existing_ohlcv_df is not None and candles_df is not None
            else existing_ohlcv_df
            if existing_ohlcv_df is not None
            else candles_df
        )

        if final_df is not None:
            ohlcv_df = self.spark.createDataFrame(final_df, schema=SchemaOHLCV).cache()
        else:
            error_message = "No data fetched and no existing df"
            raise HyperliquidDataLoaderError(error_message)

        logger.info("Converted to Spark DataFrame with schema logged.")
        if util.DEBUG:
            ohlcv_df.printSchema()
            ohlcv_df.show()

        return ohlcv_df.orderBy("timestamp")

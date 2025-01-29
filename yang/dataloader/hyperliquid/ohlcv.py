import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from ccxt import async_support as ccxt
from tenacity import retry, stop_after_attempt, wait_exponential

from yang import util

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


Timeframe = Literal["1h", "1d", "1w"]


@dataclass
class HyperliquidDataLoaderOHLCV:
    @retry(
        stop=stop_after_attempt(10),
        wait=wait_exponential(multiplier=1.12, min=0.25, max=10),
        reraise=True,
    )
    async def fetch_ohlcv(
        self,
        exchange: ccxt.Exchange,
        symbol: str,
        timeframe: str,
        since: int,
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV data for a single symbol asynchronously."""
        logger.debug("Fetching %s candles...", symbol)
        ohlcv = await exchange.fetch_ohlcv(
            symbol,
            timeframe,
            since=since,
            limit=5000,  # Hyperliquid OHLCV limit
        )

        ticker = symbol.replace("/", "_").replace(":", "_").replace("_USDC", "")
        ohlcv = [
            {
                "timestamp": datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc),
                "open": candle[1],
                "high": candle[2],
                "low": candle[3],
                "close": candle[4],
                "volume": candle[5],
                "symbol": symbol,
                "ticker": ticker,
            }
            for candle in ohlcv
        ]

        earliest_date = ohlcv[0]["timestamp"].strftime("%Y-%m-%d %H:%M:%S")
        logger.info("Fetched %s %s candles since %s", len(ohlcv), symbol, earliest_date)
        return ohlcv

    async def fetch_all_candles(
        self, exchange: ccxt.Exchange, symbols: list[str], timeframe: str, since: int
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV data for all symbols concurrently."""
        tasks = [self.fetch_ohlcv(exchange, symbol, timeframe, since) for symbol in symbols]
        results = await asyncio.gather(*tasks)
        return [candle for candles in results for candle in candles]  # Flatten results


async def fetch_ohlcv(
    exchange: ccxt.Exchange,
    symbol: str,
    timeframe: str,
    since: int,
) -> list[dict[str, Any]]:
    """Fetch OHLCV data for a single symbol asynchronously."""
    logger.debug("Fetching %s candles...", symbol)
    ohlcv = await exchange.fetch_ohlcv(
        symbol,
        timeframe,
        since=since,
        limit=5000,  # Hyperliquid OHLCV limit
    )

    ticker = symbol.replace("/", "_").replace(":", "_").replace("_USDC", "")
    ohlcv = [
        {
            "timestamp": datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc),
            "open": candle[1],
            "high": candle[2],
            "low": candle[3],
            "close": candle[4],
            "volume": candle[5],
            "symbol": symbol,
            "ticker": ticker,
        }
        for candle in ohlcv
    ]

    earliest_date = ohlcv[0]["timestamp"].strftime("%Y-%m-%d %H:%M:%S")
    logger.info("Fetched %s %s candles since %s", len(ohlcv), symbol, earliest_date)
    return ohlcv


def load_existing_candles(file_path: str) -> pd.DataFrame:
    """Load existing candles from CSV if file exists."""
    if os.path.exists(file_path):
        df = pd.read_csv(file_path, parse_dates=["timestamp"])
        return df
    return pd.DataFrame(
        columns=["timestamp", "open", "high", "low", "close", "volume", "symbol", "ticker"]
    )


def save_csv2(file_path: str, df: pd.DataFrame) -> None:
    """Save DataFrame to CSV."""
    output_path = Path(file_path)
    df.to_csv(output_path, index=False)
    logger.info("Saved to %s", output_path)


async def update_candles(exchange, symbol, timeframe, since) -> list[dict[str, Any]]:
    DATA_DIR = "./data"
    """Manages the accumulator file and fetches new candles when needed."""
    candles_file = f"{DATA_DIR}/ohlcv{timeframe}.csv"
    Path(DATA_DIR).mkdir(exist_ok=True)  # Ensure directory exists

    existing_df = load_existing_candles(candles_file)

    if not existing_df.empty:
        symbol_df = existing_df[existing_df["symbol"] == symbol]

        if not symbol_df.empty:
            last_timestamp = symbol_df.iloc[-1]["timestamp"]
            print(f"last_timestamp: {last_timestamp}")
            last_timestamp_ms = int(last_timestamp.timestamp() * 1000)

            since = max(since, last_timestamp_ms)

    print(f"since: {since}")
    # Step 3: Fetch new candles
    new_data = await fetch_ohlcv(exchange, symbol, timeframe, since)

    return new_data

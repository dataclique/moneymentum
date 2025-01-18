import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

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
        since_date = datetime.fromtimestamp(since / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        logger.info("Fetched %s %s candles since %s", len(ohlcv), symbol, since_date)

        ticker = symbol.replace("/", "_").replace(":", "_").replace("_USDC", "")

        return [
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

    async def fetch_all_candles(
        self, exchange: ccxt.Exchange, symbols: list[str], timeframe: str, since: int
    ) -> list[dict[str, Any]]:
        """Fetch OHLCV data for all symbols concurrently."""
        tasks = [self.fetch_ohlcv(exchange, symbol, timeframe, since) for symbol in symbols]
        results = await asyncio.gather(*tasks)
        return [candle for candles in results for candle in candles]  # Flatten results

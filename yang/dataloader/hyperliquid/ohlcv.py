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
        wait=wait_exponential(multiplier=1.5, min=1, max=60),
        reraise=False,
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

        candles = [
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

        earliest_date = candles[0]["timestamp"].strftime("%Y-%m-%d %H:%M:%S")
        logger.info("Fetched %s %s candles since %s", len(candles), symbol, earliest_date)
        return candles

    async def fetch_or_empty(
        self, exchange: ccxt.Exchange, symbol: str, timeframe: str, since: int
    ) -> list[dict[str, Any]]:
        try:
            return await self.fetch_ohlcv(exchange, symbol, timeframe, since)
        except Exception:
            logger.exception("Error fetching OHLCV data for %s", symbol)
            return []

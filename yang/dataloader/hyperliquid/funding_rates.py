import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ccxt import async_support as ccxt  # type: ignore[import-untyped]
from pyspark.sql import types as T
from tenacity import retry, stop_after_attempt, wait_exponential

from yang import util
from yang.dataloader.hyperliquid import HyperliquidDataLoaderError

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)

SchemaFUNDINGRATE = T.StructType(
    [
        T.StructField("timestamp", T.TimestampType()),
        T.StructField("funding_rate", T.DoubleType()),
        T.StructField("symbol", T.StringType()),
    ]
)


# Only need to normalize data for funding_rate and candles
def normalize_timestamp(timestamp: str | datetime) -> datetime:
    if isinstance(timestamp, datetime):
        # If it's already a datetime object, normalize it and return
        return timestamp.replace(microsecond=0)
    if isinstance(timestamp, str):
        # If it's a string, parse it and return as a datetime object
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).replace(microsecond=0)
    error_message = f"Unsupported timestamp type: {type(timestamp)}"
    raise TypeError(error_message)


@dataclass
class HyperliquidDataLoaderFundingRates:
    async def fetch_funding_rate_history(
        self,
        exchange: ccxt.Exchange,
        symbol: str,
        since: int,
    ) -> list[dict[str, Any]]:
        """Fetch all funding rate history for a symbol using concurrent requests."""
        # Calculate time ranges for all requests
        max_records_per_call = 500
        hours_per_batch = max_records_per_call  # Assuming hourly data
        total_hours = int(
            (
                datetime.now(timezone.utc) - datetime.fromtimestamp(since / 1000, timezone.utc)
            ).total_seconds()
            / 3600
        )

        if total_hours < 0:
            error_message = "Our df have timestamps from the future"
            raise HyperliquidDataLoaderError(error_message)

        # If nothing to fetch -- skip
        if total_hours == 0:
            return []

        # Generate all timestamp ranges
        since_values = [
            since + (i * hours_per_batch * 3600 * 1000)  # Convert hours to milliseconds
            for i in range((total_hours // hours_per_batch) + 1)
        ]

        # Create all tasks
        tasks = [
            self.fetch_funding_rate_batch(exchange, symbol, batch_since)
            for batch_since in since_values
        ]

        # Fetch all batches concurrently
        logger.info("Spawning %d concurrent requests for %s", len(tasks), symbol)
        results = await asyncio.gather(*tasks)

        # Combine and sort all results
        all_funding_rates = [rate for batch in results if batch for rate in batch]

        return sorted(all_funding_rates, key=lambda x: x["timestamp"])

    @retry(
        stop=stop_after_attempt(10),
        wait=wait_exponential(multiplier=1.5, min=1, max=10),
        reraise=True,
    )
    async def fetch_funding_rate_batch(
        self,
        exchange: ccxt.Exchange,
        symbol: str,
        since: int,
    ) -> list[dict[str, Any]]:
        """Fetch a single batch of funding rate history for a symbol."""
        since_date = datetime.fromtimestamp(since / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        logger.debug("Fetching funding rates for %s since %s...", symbol, since_date)
        try:
            funding_rates = await exchange.fetch_funding_rate_history(symbol, since=since)

            if funding_rates:
                logger.info(
                    "Fetched %s funding rates for %s since %s",
                    len(funding_rates),
                    symbol,
                    since_date,
                )
                return [
                    {
                        "timestamp": datetime.fromtimestamp(
                            rate["timestamp"] / 1000, tz=timezone.utc
                        ),
                        "funding_rate": rate["fundingRate"],
                        "symbol": symbol.replace("/", "_").replace(":", "_").replace("_USDC", ""),
                    }
                    for rate in funding_rates
                ]
        except ccxt.ExchangeNotAvailable:
            logger.exception("Exchange not available for %s", symbol)
        return []

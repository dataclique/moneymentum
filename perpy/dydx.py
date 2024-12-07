import logging
from asyncio import run, sleep
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet
from tqdm.asyncio import tqdm_asyncio

NODE_URL = "https://dydx-rpc.publicnode.com:443"
INDEXER_REST_URL = "https://indexer.dydx.trade"
INDEXER_WEBSOCKET_URL = "wss://indexer.dydx.trade/v4/ws"

MAINNET = make_mainnet(
    node_url=NODE_URL,
    rest_indexer=INDEXER_REST_URL,
    websocket_indexer=INDEXER_WEBSOCKET_URL,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


async def setup_client() -> IndexerClient:
    return IndexerClient(MAINNET.rest_indexer)


client = run(setup_client())
get_perpetual_markets = client.markets.get_perpetual_markets
get_perpetual_market_candles = client.markets.get_perpetual_market_candles


async def get_all_markets() -> list:
    response = await get_perpetual_markets()
    markets = [response["markets"][ticker] for ticker in response["markets"]]

    market_df = pd.DataFrame(markets)
    market_df = market_df[market_df["status"] == "ACTIVE"]
    market_df = market_df[market_df["marketType"] == "CROSS"]
    market_df["volume24H"] = market_df["volume24H"].astype(float)

    return market_df["ticker"].tolist()


def prep_candles(df: pd.DataFrame) -> pd.DataFrame:
    candles = df.rename(columns={"startedAt": "timestamp", "usdVolume": "volume_usd"})

    candles["timestamp"] = pd.to_datetime(candles["timestamp"], utc=True)
    candles["open"] = candles["open"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["volumeUSD"] = candles["volume_usd"].astype(float)

    return (
        candles.drop_duplicates(subset=["timestamp", "ticker"], keep="first")
        .set_index("timestamp")
        .sort_index()
    )


async def get_candles_chunk(ticker: str, start: datetime, attempt: int = 1) -> list:
    end = start + timedelta(minutes=1000)

    try:
        res = await get_perpetual_market_candles(
            market=ticker,
            resolution="1MIN",
            from_iso=start.isoformat(),
            to_iso=end.isoformat(),
        )
        return res["candles"]

    except (ValueError, KeyError) as e:
        if "too many requests" not in str.lower(str(e)) and len(str(e)) != 0:
            logger.exception(
                "Get %(ticker)s candles from %(start)s to %(end)s attempt #%(attempt)s failed",
                {"ticker": ticker, "start": start, "end": end, "attempt": attempt},
            )

            MAX_ATTEMPTS = 16
            if attempt > MAX_ATTEMPTS:
                return []

            rng = np.random.default_rng()
            await sleep(10 * rng.random())
            return await get_candles_chunk(ticker, start, attempt + 1)

        rng = np.random.default_rng()
        await sleep(10 * rng.random())
        return await get_candles_chunk(ticker, start)


async def get_candles(
    tickers: list[str], start: datetime = datetime(2024, 8, 1, tzinfo=datetime.UTC)
) -> pd.DataFrame:
    end = datetime.now(tz=datetime.UTC)
    since = (end - start).total_seconds() / 60 / 60
    chunks = int(since / 1000) + 1
    delta = timedelta(hours=1000)

    logger.info("Preparing candle fetching tasks...")
    timestamps = [start + chunk * delta for chunk in range(chunks + 1)]

    tasks = [get_candles_chunk(ticker, start) for ticker in tickers for start in timestamps]

    logger.info("Starting candle fetching...")
    res = await tqdm_asyncio.gather(*tasks, position=0)
    merged = [candle for chunk in res for candle in chunk]

    candles = prep_candles(pd.DataFrame(merged))
    candles.to_csv("./data/hourly.csv", date_format="%Y-%m-%dT%H:%M:%S.%fZ")
    return candles


async def get_order_history(
    address: str = "dydx1ef7ez77nd9ruxd6yysetcg06atlztdgvnv3h45",
) -> pd.DataFrame:
    orders = await client.account.get_subaccount_orders(address, 0)
    orders_df = pd.DataFrame(orders)
    orders_df["size"] = orders_df["size"].astype(float)
    orders_df["price"] = orders_df["price"].astype(float)

    return orders_df.set_index("updatedAt").sort_index()

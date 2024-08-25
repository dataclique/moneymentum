import os
import asyncio
import pandas as pd
from tqdm.asyncio import tqdm_asyncio
from datetime import datetime, timedelta
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet

NODE_URL = "https://dydx-rpc.publicnode.com:443"
INDEXER_REST_URL = "https://indexer.dydx.trade"
INDEXER_WEBSOCKET_URL = "wss://indexer.dydx.trade/v4/ws"

MAINNET = make_mainnet(
    node_url=NODE_URL,
    rest_indexer=INDEXER_REST_URL,
    websocket_indexer=INDEXER_WEBSOCKET_URL,
)


async def setup_client():
    return IndexerClient(MAINNET.rest_indexer)


client = asyncio.run(setup_client())


async def get_all_markets() -> pd.DataFrame:
    response = await client.markets.get_perpetual_markets()
    markets = [response["markets"][ticker] for ticker in response["markets"]]

    df = pd.DataFrame(markets)
    df = df[df["status"] == "ACTIVE"]
    df = df[df["marketType"] == "CROSS"]
    df["volume24H"] = df["volume24H"].astype(float)
    df = df[df["volume24H"] > 1000]
    df = df[df["trades24H"] > 10]

    df = df.drop(
        columns=["status", "marketType", "openInterestLowerCap", "openInterestUpperCap"]
    )

    print(df.info())
    return df


async def get_candle_batch(ticker: str, end) -> tuple:
    week = timedelta(weeks=1)
    start = end - week

    print(f"Getting candles for {ticker} from {start} to {end}")
    response = await client.markets.get_perpetual_market_candles(
        market=ticker,
        resolution="1HOUR",
        from_iso=start.isoformat(),
        to_iso=end.isoformat(),
    )

    unneeded_columns = [
        "ticker",
        "resolution",
        "startedAt",
        "baseTokenVolume",
        "startingOpenInterest",
        "orderbookMidPriceOpen",
        "orderbookMidPriceClose",
    ]

    candles = pd.DataFrame(response["candles"])
    candles["open"] = candles["open"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["usdVolume"] = candles["usdVolume"].astype(float)
    candles["timestamp"] = candles["startedAt"].astype(str)
    candles.drop(columns=unneeded_columns, inplace=True)

    return candles, start


async def get_candles(market: str, end=datetime.now()) -> pd.DataFrame:
    try:
        batch, start = await get_candle_batch(market, end)
        rest = await get_candles(market, start)
        candles = pd.concat([batch, rest])
        candles.sort_values("timestamp", inplace=True)
        return candles
    except Exception as e:
        return pd.DataFrame()


os.makedirs("./data/candles", exist_ok=True)

markets = asyncio.run(get_all_markets())
markets.to_csv("./data/markets.csv", index=False)


async def backfill_market(market):
    ticker = market["ticker"]
    candles = await get_candles(ticker)
    token = str.lower(ticker.split("-")[0])
    candles.to_csv(f"./data/candles/{token}.csv", index=False)


tasks = [backfill_market(market) for index, market in markets.iterrows()]
asyncio.run(tqdm_asyncio.gather(*tasks))

from asyncio import run
from datetime import datetime, timedelta
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet
from tqdm.asyncio import tqdm_asyncio
import os
import pandas as pd

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


client = run(setup_client())
get_perpetual_markets = client.markets.get_perpetual_markets
get_perpetual_market_candles = client.markets.get_perpetual_market_candles


async def get_all_markets() -> list:
    response = await get_perpetual_markets()
    markets = [response["markets"][ticker] for ticker in response["markets"]]

    df = pd.DataFrame(markets)
    df = df[df["status"] == "ACTIVE"]
    df = df[df["marketType"] == "CROSS"]
    df["volume24H"] = df["volume24H"].astype(float)
    df = df[df["volume24H"] > 10000]
    df = df[df["trades24H"] > 10]

    return df["ticker"].tolist()


def prep_candles(candles: pd.DataFrame) -> pd.DataFrame:
    candles["startedAt"] = pd.to_datetime(candles["startedAt"])
    candles["open"] = candles["open"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["usdVolume"] = candles["usdVolume"].astype(float)

    candles.set_index("startedAt", inplace=True)
    candles.sort_index(inplace=True)

    by_ticker = candles.groupby("ticker")
    candles["return"] = candles["close"] / by_ticker["close"].transform("first")
    candles["inv_return"] = 1 / candles["return"]

    return candles


async def get_candles_chunk(ticker: str, end, chunks, hours_each=24) -> pd.DataFrame:
    delta = timedelta(hours=hours_each)
    start = end - chunks * delta
    end = start + delta

    try:
        res = await get_perpetual_market_candles(
            market=ticker,
            resolution="1HOUR",
            from_iso=start.isoformat(),
            to_iso=end.isoformat(),
        )
        return pd.DataFrame(res["candles"])
    except Exception as e:
        print(f"Getting {ticker} candles for {start}-{end} failed, retrying")
        res = await get_candles_chunk(ticker, end, chunks)
        return res


end = datetime.now()


async def get_ticker_candles(ticker: str, days: int) -> pd.DataFrame:
    tasks = [get_candles_chunk(ticker, end, i + 1) for i in range(days)]
    res = await tqdm_asyncio.gather(*tasks, position=1)
    df = pd.concat(res, ignore_index=True)

    df["startedAt"] = pd.to_datetime(df["startedAt"])
    df["open"] = df["open"].astype(float)
    df["high"] = df["high"].astype(float)
    df["low"] = df["low"].astype(float)
    df["close"] = df["close"].astype(float)
    df["usdVolume"] = df["usdVolume"].astype(float)

    print(df)
    return df


async def get_candles(tickers, days=1):
    tasks = [get_ticker_candles(ticker, days) for ticker in tickers]
    res = await tqdm_asyncio.gather(*tasks, position=0)

    df = pd.concat(res, ignore_index=True)
    df.set_index("startedAt", inplace=True)
    df.sort_index(inplace=True)

    for i, ticker in enumerate(tickers):
        candles = df[df["ticker"] == ticker]
        start_price = candles["close"].iloc[0]
        df.loc[df["ticker"] == ticker, "return"] = candles["close"] / start_price

    df["inv_return"] = 1 / df["return"]
    return df

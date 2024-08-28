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


async def get_candles_for_tickers(tickers: list, **kwargs) -> pd.DataFrame:
    tasks = [
        get_perpetual_market_candles(**kwargs, market=ticker) for ticker in tickers
    ]
    responses = await tqdm_asyncio.gather(*tasks, position=0)
    return prep_candles(pd.concat([pd.DataFrame(res["candles"]) for res in responses]))


def prep_candles(candles: pd.DataFrame) -> pd.DataFrame:
    candles.rename(columns={"startedAt": "timestamp"}, inplace=True)
    candles["timestamp"] = pd.to_datetime(candles["timestamp"])
    candles["open"] = candles["open"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["usdVolume"] = candles["usdVolume"].astype(float)

    by_ticker = candles.groupby("ticker")
    candles["return"] = candles["close"] / by_ticker["close"].transform("first")
    candles["inv_return"] = 1 / candles["return"]

    candles.set_index("timestamp", inplace=True)
    candles.sort_index(inplace=True)

    return candles


async def get_candles_chunk(
    ticker: str, start: datetime, end: datetime
) -> pd.DataFrame:
    try:
        res = await get_perpetual_market_candles(
            market=ticker,
            resolution="1MIN",
            from_iso=start.isoformat(),
            to_iso=end.isoformat(),
        )
        return pd.DataFrame(res["candles"])
    except Exception as e:
        print(f"Getting {ticker} candles for {start}-{end} failed: {e}")
        res = await get_candles_chunk(ticker, start, end)
        return res


async def get_candles(tickers, start: datetime):
    end = datetime.now()
    since = (end - start).total_seconds() / 60
    chunks = int(since / 1000) + 1
    delta = timedelta(minutes=1000)

    tasks = [
        get_candles_chunk(ticker, start + chunk * delta, start + (chunk + 1) * delta)
        for chunk in range(chunks)
        for ticker in tickers
    ]
    res = await tqdm_asyncio.gather(*tasks, position=0)

    df = prep_candles(pd.concat(res))
    df.to_csv("./data/candles.csv")
    return df


async def get_order_history(
    address="dydx1ef7ez77nd9ruxd6yysetcg06atlztdgvnv3h45",
) -> pd.DataFrame:
    orders = await client.account.get_subaccount_orders(address, 0)
    df = pd.DataFrame(orders)
    df["size"] = df["size"].astype(float)
    df["price"] = df["price"].astype(float)
    df.set_index("updatedAt", inplace=True)
    df.sort_index(inplace=True)
    return df

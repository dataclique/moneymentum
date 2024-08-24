import asyncio
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet
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


async def get_candles(market: str) -> pd.DataFrame:
    response = await client.markets.get_perpetual_market_candles(
        market=market, resolution="1HOUR"
    )
    candles = pd.DataFrame(response["candles"]).drop(columns=["ticker", "resolution"])
    candles["close"] = candles["close"].astype(float)
    candles["open"] = candles["open"].astype(float)
    candles.sort_values("startedAt", inplace=True)

    return candles


async def get_markets_candles() -> pd.DataFrame:
    markets = await get_all_markets()

    for market in markets.iterrows():
        ticker = market[1]["ticker"]
        candles = await get_candles(ticker)

        markets.loc[market[0], "diff_24h"] = (
            1 - candles["close"].iloc[-1] / candles["open"].iloc[-24]
        )
        markets.loc[market[0], "diff_7d"] = (
            1 - candles["close"].iloc[-1] / candles["open"].iloc[-7 * 24]
        )

        if candles.shape[0] < 30 * 24:
            continue

        markets.loc[market[0], "diff_30d"] = (
            1 - candles["close"].iloc[-1] / candles["open"].iloc[-30 * 24]
        )

        print(markets.loc[market[0]], "\n")

    return markets


markets = asyncio.run(get_markets_candles())
markets.to_csv("markets.csv", index=False)

csv = "markets.csv"
df = pd.read_csv(csv)

df.info()

df.sort_values("diff_30d", ascending=False, inplace=True)
print(df.head())
print(df.tail())

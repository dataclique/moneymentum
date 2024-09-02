from asyncio import run, sleep
from datetime import datetime, timedelta
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet
from tqdm.asyncio import tqdm_asyncio
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
    candles.rename(
        columns={"startedAt": "timestamp", "usdVolume": "volume_usd"}, inplace=True
    )

    candles["timestamp"] = pd.to_datetime(candles["timestamp"])
    candles["open"] = candles["open"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["volume_usd"] = candles["volume_usd"].astype(float)
    candles["return"] = candles.groupby("ticker")["close"].pct_change()

    candles.set_index("timestamp", inplace=True)
    candles.sort_index(inplace=True)

    return candles  # .dropna()


async def get_candles_chunk(
    ticker: str, start: datetime, end: datetime, attempt: int = 1
) -> list:
    # print(f"Getting candles for {ticker} from {start} to {end}")

    try:
        res = await get_perpetual_market_candles(
            market=ticker,
            resolution="1MIN",
            from_iso=start.isoformat(),
            to_iso=end.isoformat(),
        )
        return res["candles"]

    except Exception as e:
        print(
            f"Get {ticker} candles from {start} to {end} attempt #{attempt} failed:\n{e}"
        )

        if attempt > 256:
            return []

        await sleep(attempt / 10)
        res = await get_candles_chunk(ticker, start, end, attempt + 1)
        return res


async def get_candles(tickers, start: datetime = datetime(2024, 8, 25)):
    end = datetime.now()
    since = (end - start).total_seconds() / 60
    chunks = int(since / 1000) + 1
    delta = timedelta(minutes=1000)

    df = prep_candles(pd.read_csv("./data/candles.csv"))
    tasks = [
        get_candles_chunk(ticker, start + chunk * delta, start + (chunk + 1) * delta)
        for chunk in range(chunks + 1)
        for ticker in tickers
        if df[
            (df.index == pd.to_datetime(start + chunk * delta).tz_localize("UTC"))
            & (df["ticker"] == ticker)
        ].empty
    ]

    res = await tqdm_asyncio.gather(*tasks, position=0)
    merged = [candle for chunk in res for candle in chunk]
    if len(merged) == 0:
        return df

    new_df = prep_candles(pd.DataFrame(merged))
    candles = pd.concat([df, new_df])
    candles.sort_index(inplace=True)
    candles.to_csv("./data/candles.csv")

    return candles


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

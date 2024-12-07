from asyncio import run
from datetime import datetime, timedelta, timezone

import matplotlib.pyplot as plt
import pandas as pd
from dydx_v4_client.exceptions import APIError, RequestError
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

# Constants
VOLUME_THRESHOLD = 10000
TRADE_THRESHOLD = 10
MIN_VOLUME = 100


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
    market_df = market_df[market_df["volume24H"] > VOLUME_THRESHOLD]
    market_df = market_df[market_df["trades24H"] > TRADE_THRESHOLD]

    return market_df["ticker"].tolist()


async def get_candles_chunk(ticker: str, end: datetime, chunks: int) -> pd.DataFrame:
    delta = timedelta(minutes=1000)
    start = end - chunks * delta
    end = start + delta

    try:
        res = await client.markets.get_perpetual_market_candles(
            market=ticker,
            resolution="1MIN",
            from_iso=start.isoformat(),
            to_iso=end.isoformat(),
        )
        return pd.DataFrame(res["candles"])
    except (RequestError, APIError):
        res = await get_candles_chunk(ticker, end, chunks)
        return pd.DataFrame(res["candles"])


end = datetime.now(tz=timezone.utc)


async def get_candles(ticker: str) -> pd.DataFrame:
    res1 = await get_candles_chunk(ticker, end, 1)
    res2 = await get_candles_chunk(ticker, end, 2)
    res3 = await get_candles_chunk(ticker, end, 3)

    res = [res1, res2, res3]
    candles = pd.concat(res, ignore_index=True)

    candles["startedAt"] = pd.to_datetime(candles["startedAt"])
    candles["open"] = candles["open"].astype(float)
    candles["high"] = candles["high"].astype(float)
    candles["low"] = candles["low"].astype(float)
    candles["close"] = candles["close"].astype(float)
    candles["usdVolume"] = candles["usdVolume"].astype(float)
    return candles


tickers = run(get_all_markets())


def get_picks() -> tuple[list, list]:
    tasks = [get_candles_chunk(ticker, end, 4) for ticker in tickers]
    res = run(tqdm_asyncio.gather(*tasks))

    candles_df = pd.concat(res, ignore_index=True)
    candles_df = candles_df.set_index("startedAt")
    candles_df = candles_df.sort_index()

    ticker_returns = {}
    for _, ticker in enumerate(tickers):
        candles = candles_df[candles_df["ticker"] == ticker]
        if candles["usdVolume"].mean() < MIN_VOLUME:
            continue

        start_price = candles["close"].iloc[0]
        candles_df.loc[candles_df["ticker"] == ticker, "return"] = candles["close"] / start_price
        ticker_returns[ticker] = candles["close"].iloc[-1] / start_price

    returns = pd.DataFrame(ticker_returns.items(), columns=["ticker", "return"])
    returns = returns.set_index("ticker")
    returns = returns.sort_values("return", ascending=False)

    candles_df["inv_return"] = 1 / candles_df["return"]

    n = 4
    top = returns.head(n).index.tolist()
    bottom = returns.tail(n).index.tolist()

    return [top, bottom]


tickers = run(get_all_markets())
[top, bottom] = get_picks()
tasks = [get_candles(ticker) for ticker in tickers]
res = run(tqdm_asyncio.gather(*tasks))

market_data = pd.DataFrame()
market_data = pd.concat(res, ignore_index=True)
market_data = market_data.set_index("startedAt")
market_data = market_data.sort_index()

for _, ticker in enumerate(tickers):
    candles = market_data[market_data["ticker"] == ticker]
    if candles["usdVolume"].mean() < MIN_VOLUME:
        continue

    start_price = candles["close"].iloc[0]
    market_data.loc[market_data["ticker"] == ticker, "return"] = candles["close"] / start_price

market_data["inv_return"] = 1 / market_data["return"]

market = market_data.groupby("startedAt")["return"].mean()
inv_market = market_data.groupby("startedAt")["inv_return"].mean()
long_returns = market_data[market_data["ticker"].isin(top)].groupby("startedAt")["return"].mean()
short_returns = (
    market_data[market_data["ticker"].isin(bottom)].groupby("startedAt")["inv_return"].mean()
)
portfolio = (long_returns + short_returns) / 2

colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
fig, ax = plt.subplots(3, figsize=(12, 8))

for _, ticker in enumerate(top):
    candles = market_data[market_data["ticker"] == ticker]
    label = ticker.split("-")[0]
    ax[0].plot(candles["return"], label=label, color=colors[0])

for _, ticker in enumerate(bottom):
    candles = market_data[market_data["ticker"] == ticker]
    label = ticker.split("-")[0]
    ax[0].plot(candles["return"], label=label, color=colors[1])

ax[0].axhline(1, color="black", linestyle="--")
ax[0].set_ylabel("roi")
ax[0].set_title("perp returns")
ax[0].legend(bbox_to_anchor=[1, 1])

ax[1].plot(portfolio, label="portfolio", color=colors[1])
ax[1].plot(market, label="market", color=colors[0])
ax[1].plot(long_returns, label="longs", color=colors[2])
ax[1].plot(short_returns, label="shorts", color=colors[3])

ax[1].axhline(1, color="black", linestyle="--")
ax[1].set_ylabel("roi")
ax[1].set_title("portfolio returns")
ax[1].legend(bbox_to_anchor=[1, 1])

ax[2].plot(portfolio / market, label="portfolio", color=colors[1])
ax[2].plot(long_returns / market, label="long", color=colors[4])
ax[2].plot(short_returns / inv_market, label="short", color=colors[5])

ax[2].axhline(1, color="black", linestyle="--")
ax[2].set_ylabel("roi ratio")
ax[2].set_title("portfolio/market")
ax[2].legend(bbox_to_anchor=[1, 1])

plt.tight_layout()
plt.show()

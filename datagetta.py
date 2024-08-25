from asyncio import run
from datetime import datetime, timedelta
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet
from tqdm.asyncio import tqdm_asyncio
import matplotlib.pyplot as plt
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


async def get_candles(ticker: str) -> pd.DataFrame:
    res = await get_perpetual_market_candles(
        market=ticker, resolution="1HOUR", limit=24 * 30
    )

    columns = ["ticker", "startedAt", "open", "high", "low", "close", "usdVolume"]
    df = pd.DataFrame(res["candles"])[columns]

    df["startedAt"] = pd.to_datetime(df["startedAt"])
    df["open"] = df["open"].astype(float)
    df["high"] = df["high"].astype(float)
    df["low"] = df["low"].astype(float)
    df["close"] = df["close"].astype(float)
    df["usdVolume"] = df["usdVolume"].astype(float)
    return df


tickers = run(get_all_markets())
tasks = [get_candles(ticker) for ticker in tickers]
res = run(tqdm_asyncio.gather(*tasks))

df = pd.concat(res, ignore_index=True)
df.set_index("startedAt", inplace=True)
df.sort_index(inplace=True)


for ticker in tickers:
    candles = df[df["ticker"] == ticker]
    start_price = candles["close"].iloc[0]
    df.loc[df["ticker"] == ticker, "return"] = candles["close"] / start_price

df["inv_return"] = 1 / df["return"]

ticker_returns = {}
for i, ticker in enumerate(tickers):
    candles = df[df["ticker"] == ticker]
    if candles["usdVolume"].mean() < 1000:
        continue

    candles["prior_return"] = candles["close"].shift(-8) / candles["close"]
    ticker_returns[ticker] = candles["prior_return"].mean()

returns = pd.DataFrame(
    ticker_returns.items(), columns=["ticker", "prior_return"], index=None
)
returns.set_index("ticker", inplace=True)
returns.sort_values("prior_return", ascending=False, inplace=True)
print(returns)

# only include top/bottom 5 percentile
n = 4
top = returns.head(n).index.tolist()
bottom = returns.tail(n).index.tolist()

colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
fig, ax = plt.subplots(3, figsize=(12, 8))

for i, ticker in enumerate(top):
    candles = df[df["ticker"] == ticker]
    label = ticker.split("-")[0]
    ax[0].plot(candles["return"], label=label, color=colors[0])

for i, ticker in enumerate(bottom):
    candles = df[df["ticker"] == ticker]
    label = ticker.split("-")[0]
    ax[0].plot(candles["return"], label=label, color=colors[1])

ax[0].axhline(1, color="black", linestyle="--")
ax[0].set_ylabel("roi")
ax[0].set_title("perp returns")
ax[0].legend(bbox_to_anchor=[1, 0.6])


market = df.groupby("startedAt")["return"].mean()
inv_market = df.groupby("startedAt")["inv_return"].mean()
long_returns = df[df["ticker"].isin(top)].groupby("startedAt")["return"].mean()
short_returns = df[df["ticker"].isin(bottom)].groupby("startedAt")["inv_return"].mean()
portfolio = (3 * long_returns + 2 * short_returns) / 5

ax[1].plot(market, label="market", color=colors[0])
ax[1].plot(long_returns, label="longs", color=colors[2])
ax[1].plot(short_returns, label="shorts", color=colors[3])
ax[1].plot(portfolio, label="portfolio", color=colors[1])

ax[1].axhline(1, color="black", linestyle="--")
ax[1].set_ylabel("roi")
ax[1].set_title("portfolio returns")
ax[1].legend(bbox_to_anchor=[1, 0.6])

ax[2].plot(long_returns / market, label="long", color=colors[4])
ax[2].plot(short_returns / inv_market, label="short", color=colors[5])
ax[2].plot(portfolio / market, label="portfolio", color=colors[1])

ax[2].axhline(1, color="black", linestyle="--")
ax[2].set_ylabel("roi ratio")
ax[2].set_title("portfolio/market")
ax[2].legend(bbox_to_anchor=[1, 0.6])

plt.tight_layout()
plt.show()

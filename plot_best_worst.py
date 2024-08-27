from asyncio import run
import pandas as pd
import numpy as np
from tqdm.asyncio import tqdm_asyncio

from perpy.dydx import get_all_markets, get_candles_for_tickers, prep_candles
from perpy.viz import plot_tickers


def get_bestworst(df, n=4):
    ticker_returns = {}
    for i, ticker in enumerate(tickers):
        candles = df[df["ticker"] == ticker]
        if candles["usdVolume"].mean() < 100:
            continue

        start_price = candles["close"].iloc[0]
        ticker_returns[ticker] = candles["close"].iloc[-1] / start_price

    returns = pd.DataFrame(
        ticker_returns.items(), columns=["ticker", "return"], index=None
    )
    returns.set_index("ticker", inplace=True)
    returns.sort_values("return", ascending=False, inplace=True)

    top = returns.head(n).index.tolist()
    bottom = returns.tail(n).index.tolist()

    return [top, bottom]


tickers = run(get_all_markets())

candles_1h = run(get_candles_for_tickers(tickers, resolution="1HOUR"))
month = candles_1h.loc[candles_1h.index > candles_1h.index[-1] - pd.Timedelta(days=30)]

best, worst = get_bestworst(month, 5)
candles_1m = run(get_candles_for_tickers(best + worst, resolution="1MIN"))

print(f"30d top performers: {best}")
print(f"30d bottom performers: {worst}")

week = candles_1h.loc[candles_1h.index > candles_1h.index[-1] - pd.Timedelta(days=7)]
day = candles_1m.loc[candles_1m.index > candles_1m.index[-1] - pd.Timedelta(days=1)]


def plot():
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(3, figsize=(12, 8))

    plot_tickers(ax[0], month, best, title="30d")
    plot_tickers(ax[0], month, worst, True, "30d")

    plot_tickers(ax[1], week, best, title="7d")
    plot_tickers(ax[1], week, worst, True, "7d")

    plot_tickers(ax[2], day, best, title="1d")
    plot_tickers(ax[2], day, worst, True, "1d")

    plt.tight_layout()
    plt.show()


plot()

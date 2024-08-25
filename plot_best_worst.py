from asyncio import run
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
from tqdm.asyncio import tqdm_asyncio

from perpy.dydx import get_all_markets, get_perpetual_market_candles, prep_candles
from perpy.viz import plot_tickers


def get_bestworst(df):
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

    n = 4
    top = returns.head(n).index.tolist()
    bottom = returns.tail(n).index.tolist()

    return [top, bottom]


async def main():
    tickers = await get_all_markets()

    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    fig, ax = plt.subplots(2, figsize=(12, 8))

    tasks = [
        get_perpetual_market_candles(market=ticker, resolution="1HOUR")
        for ticker in tickers
    ]
    responses = await tqdm_asyncio.gather(*tasks, position=0)
    hourly_candles = prep_candles(
        pd.concat([pd.DataFrame(res["candles"]) for res in responses])
    )

    month = hourly_candles.loc[
        hourly_candles.index > hourly_candles.index[-1] - pd.Timedelta(days=30)
    ]

    if month.size != 24 * 30:
        exit(1)

    month_top, month_bottom = get_bestworst(month)
    plot_tickers(ax[0], month, month_top, title="30d")
    plot_tickers(ax[0], month, month_bottom, True, "30d")

    week = hourly_candles.loc[
        hourly_candles.index > hourly_candles.index[-1] - pd.Timedelta(days=7)
    ]
    week_top, week_bottom = get_bestworst(week)
    plot_tickers(ax[1], week, week_top, title="7d")
    plot_tickers(ax[1], week, week_bottom, True, "7d")

    plt.tight_layout()
    plt.show()


run(main())

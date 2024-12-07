import logging
from asyncio import run

import pandas as pd

from perpy.dydx import get_all_markets, get_candles_for_tickers
from perpy.picks import get_bestworst
from perpy.viz import plot_tickers

tickers = run(get_all_markets())

candles_1h = run(get_candles_for_tickers(tickers, resolution="1MIN"))
month = candles_1h.loc[candles_1h.index > candles_1h.index[-1] - pd.Timedelta(days=30)]

best, worst = get_bestworst(month, tickers, 5)
candles_1m = run(get_candles_for_tickers(best + worst, resolution="1MIN"))

logging.info("30d top performers: %s", best)
logging.info("30d bottom performers: %s", worst)

week = candles_1h.loc[candles_1h.index > candles_1h.index[-1] - pd.Timedelta(days=7)]
day = candles_1m.loc[candles_1m.index > candles_1m.index[-1] - pd.Timedelta(days=1)]


def plot() -> None:
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(3, figsize=(12, 8))

    plot_tickers(ax[0], month, best, title="30d")
    plot_tickers(ax[0], month, worst, inv_colors_ix=True, title="30d")

    plot_tickers(ax[1], week, best, title="7d")
    plot_tickers(ax[1], week, worst, inv_colors_ix=True, title="7d")

    plot_tickers(ax[2], day, best, title="1d")
    plot_tickers(ax[2], day, worst, inv_colors_ix=True, title="1d")

    plt.tight_layout()
    plt.show()


plot()

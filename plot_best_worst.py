from asyncio import run
import pandas as pd

from perpy.dydx import get_all_markets, get_candles_for_tickers
from perpy.viz import plot_tickers
from perpy.picks import get_bestworst


tickers = run(get_all_markets())

candles_1h = run(get_candles_for_tickers(tickers, resolution="1MIN"))
month = candles_1h.loc[candles_1h.index > candles_1h.index[-1] - pd.Timedelta(days=30)]

best, worst = get_bestworst(month, tickers, 5)
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

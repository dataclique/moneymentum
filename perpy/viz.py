from asyncio import run
from datetime import datetime, timedelta
from tqdm.asyncio import tqdm_asyncio
import matplotlib.pyplot as plt
import os
import pandas as pd

colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]


def plot_tickers(ax, df, tickers, inv_colors_ix=False, title="perp returns"):
    for i, ticker in enumerate(tickers):
        candles = df[df["ticker"] == ticker]
        label = ticker.split("-")[0]
        color_ix = (-1 if inv_colors_ix else 1) * ((i + 1) % len(colors))
        ax.plot(candles["return"], label=label, color=colors[color_ix])

    ax.axhline(1, color="black", linestyle="--")
    ax.set_ylabel("returns")
    ax.set_title(title)
    ax.legend(bbox_to_anchor=[1, 0.6])

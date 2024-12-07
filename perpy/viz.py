import matplotlib.pyplot as plt
import pandas as pd

colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]


def plot_tickers(
    ax: plt.Axes,
    df: pd.DataFrame,
    tickers: list[str],
    *,  # Force keyword arguments after this point
    inv_colors_ix: bool = False,
    title: str = "perp returns",
) -> None:
    for i, ticker in enumerate(tickers):
        candles = df[df["ticker"] == ticker]
        label = ticker.split("-")[0]
        color_ix = (-1 if inv_colors_ix else 1) * ((i + 1) % len(colors))
        ax.plot(candles["return"], label=label, color=colors[color_ix])

    ax.axhline(1, color="black", linestyle="--")
    ax.set_ylabel("returns")
    ax.set_title(title)
    ax.legend(bbox_to_anchor=[1, 0.6])

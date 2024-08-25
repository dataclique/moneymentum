import numpy as np
import pandas as pd
import matplotlib.pyplot as plt


def calcRSI(data, P=14):
    data["diff_close"] = data["close"] - data["close"].shift(1)
    data["gain"] = np.where(data["diff_close"] > 0, data["diff_close"], 0)
    data["loss"] = np.where(data["diff_close"] < 0, np.abs(data["diff_close"]), 0)
    data[["init_avg_gain", "init_avg_loss"]] = data[["gain", "loss"]].rolling(P).mean()
    avg_gain = np.zeros(len(data))
    avg_loss = np.zeros(len(data))

    for i, _row in enumerate(data.iterrows()):
        row = _row[1]
        if i < P - 1:
            last_row = row.copy()
            continue
        elif i == P - 1:
            avg_gain[i] += row["init_avg_gain"]
            avg_loss[i] += row["init_avg_loss"]
        else:
            avg_gain[i] += ((P - 1) * avg_gain[i - 1] + row["gain"]) / P
            avg_loss[i] += ((P - 1) * avg_loss[i - 1] + row["loss"]) / P
        last_row = row.copy()
    data["avg_gain"] = avg_gain
    data["avg_loss"] = avg_loss
    data["RS"] = data["avg_gain"] / data["avg_loss"]
    data["RSI"] = 100 - 100 / (1 + data["RS"])
    return data


jup_df = pd.read_csv(f"./data/candles/jup.csv")
wif_df = pd.read_csv(f"./data/candles/wif.csv")

colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

# single plot with two lines
fig, ax = plt.subplots(1, figsize=(12, 8))
ax.plot(jup_df["close"], label="JUP")
ax.plot(wif_df["close"], label="WIF")
ax.set_ylabel("USD")
ax.set_title("wip viz")
ax.legend(bbox_to_anchor=[1, 0.6])
plt.tight_layout()
plt.show()


# print(ax)

# ax[0].plot(jup_df["close"])
# ax[0].plot(jup_df["close"])
# ax[0].set_ylabel("USD")
# ax[0].set_title("wip viz")
# ax[0].legend(bbox_to_anchor=[1, 0.6])

# plt.tight_layout()
# plt.show()


# # Standard Mean Reversion
# def RSIReversionStrategy(
#     data, P=14, long_level=30, short_level=70, centerline=50, shorts=True
# ):
#     """
#     Goes long when RSI < long level, sells when the value crosses the
#     centerline.
#     Goes short when RSI > short level, covers when it crosses the
#     centerline.
#     """
#     df = calcRSI(data, P=P)

#     df["position"] = np.nan
#     df["position"] = np.where(df["RSI"] < long_level, 1, df["position"])
#     if shorts:
#         df["position"] = np.where(df["RSI"] > short_level, -1, df["position"])
#     if centerline is not None:
#         # Exit when RSI crosses sell_level
#         _sell_level = df["RSI"] - centerline
#         df["cross_sell_level"] = _sell_level.shift(1) / _sell_level
#         df["position"] = np.where(df["cross_sell_level"] < 0, 0, df["position"])
#     else:
#         df["position"] = np.where(df["RSI"] >= short_level, 0, df["position"])

#     df["position"] = df["position"].ffill().fillna(0)

#     return calcReturns(df)


# def calcReturns(df):
#     # Helper function to avoid repeating too much code
#     df["returns"] = df["close"] / df["close"].shift(1)
#     df["log_returns"] = np.log(df["returns"])
#     df["strat_returns"] = df["position"].shift(1) * df["returns"]
#     df["strat_log_returns"] = df["position"].shift(1) * df["log_returns"]
#     df["cum_returns"] = np.exp(df["log_returns"].cumsum()) - 1
#     df["strat_cum_returns"] = np.exp(df["strat_log_returns"].cumsum()) - 1
#     df["peak"] = df["cum_returns"].cummax()
#     df["strat_peak"] = df["strat_cum_returns"].cummax()
#     return df


# df_rev = RSIReversionStrategy(df.copy())

# # Plot results
# ax[0].plot(df_rev["strat_cum_returns"] * 100, label="Mean Reversion")
# ax[0].plot(df_rev["cum_returns"] * 100, label="Buy and Hold")
# ax[0].set_ylabel("Returns (%)")
# ax[0].set_title(
#     "Cumulative Returns for Mean Reversion and"
#     + f" Buy and Hold Strategies for {ticker}"
# )
# ax[0].legend(bbox_to_anchor=[1, 0.6])
# ax[1].plot(df_rev["RSI"], label="RSI", linewidth=1)
# ax[1].axhline(70, label="Over Bought", color=colors[1], linestyle=":")
# ax[1].axhline(30, label="Over Sold", color=colors[2], linestyle=":")
# ax[1].axhline(50, label="Centerline", color="k", linestyle=":")
# ax[1].set_ylabel("RSI")
# ax[1].set_xlabel("Date")
# ax[1].set_title(f"RSI for {ticker}")
# ax[1].legend(bbox_to_anchor=[1, 0.75])
# plt.tight_layout()
# plt.show()

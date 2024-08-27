from asyncio import run
import pandas as pd
import numpy as np
from tqdm.asyncio import tqdm_asyncio

from perpy.dydx import get_all_markets, get_candles_for_tickers, prep_candles
from perpy.viz import plot_tickers
from perpy.picks import get_bestworst
from perpy.dydx import get_order_history


# tickers = run(get_all_markets())
# df = run(get_candles_for_tickers(tickers, resolution="1HOUR"))
# df.to_csv("./data/candles.csv")

df = pd.read_csv("./data/candles.csv")
df.set_index("startedAt", inplace=True)
df.sort_index(inplace=True)

tickers = df["ticker"].unique()
best, worst = get_bestworst(df, tickers, 3)


from dash import Dash, html, dcc, callback, Output, Input
import plotly.express as px
import pandas as pd
import plotly.graph_objects as go

app = Dash()

best_worst_fig = px.area(
    df[df["ticker"].isin(best + worst)],
    y="return",
    line_group="ticker",
    color="ticker",
)

order_df = run(get_order_history())

order_df["bet"] = order_df["size"] * order_df["price"]
order_df["bets"] = order_df.groupby("ticker")["bet"].cumsum()
order_df["cum_bets"] = order_df["bets"] + order_df["bets"].shift(1)

order_fig = px.area(order_df, y="cum_bets")
order_fig.update_layout(
    title="Portfolio",
    xaxis_title="Time",
    yaxis_title="Bets",
    xaxis_rangeslider_visible=True,
)

app.layout = [
    html.H1(children="dYdX", style={"textAlign": "center"}),
    dcc.Graph(id="orders", figure=order_fig),
    dcc.Dropdown(df["ticker"].unique(), "BTC-USD", id="dropdown-selection"),
    dcc.Graph(id="ticker"),
    dcc.Graph(id="best-worst-performers", figure=best_worst_fig),
]


@callback(Output("ticker", "figure"), Input("dropdown-selection", "value"))
def update_graph(ticker):
    dff = df[df["ticker"] == ticker]
    fig = go.Figure(
        go.Candlestick(
            x=dff.index,
            open=dff["open"],
            high=dff["high"],
            low=dff["low"],
            close=dff["close"],
        )
    )
    fig.update_layout(
        title=f"{ticker} 1H candles",
        xaxis_title="Time",
        yaxis_title="Price",
        xaxis_rangeslider_visible=True,
    )
    return fig


if __name__ == "__main__":
    app.run(debug=True)

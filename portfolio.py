from asyncio import run

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from dash import Dash, Input, Output, callback, dcc, html

from perpy.dydx import get_order_history
from perpy.picks import get_bestworst

# tickers = run(get_all_markets())
# df = run(get_candles_for_tickers(tickers, resolution="1HOUR"))
# df.to_csv("./data/candles.csv")

candles_df = pd.read_csv("./data/candles.csv")
candles_df = candles_df.set_index("startedAt")
candles_df = candles_df.sort_index()

tickers = candles_df["ticker"].unique()
best, worst = get_bestworst(candles_df, tickers, 5)


app = Dash()

order_df = run(get_order_history())

order_df["bet"] = order_df["size"] * order_df["price"]
order_df["bets"] = order_df.groupby("ticker")["bet"].cumsum()
order_df["cum_bets"] = order_df["bets"] + order_df["bets"].shift(1)

order_fig = px.area(order_df, y="cum_bets")
order_fig.update_layout(
    xaxis_title="Time",
    yaxis_title="Bets",
    xaxis_rangeslider_visible=True,
)

app.layout = [
    html.H1(children="dYdX", style={"textAlign": "center"}),
    html.Div(
        [
            dcc.Dropdown(["Best&Worst", "Best", "Worst", "All"], "Best&Worst", id="token-group"),
            dcc.Graph(id="best-worst-performers"),
            #     ],
            #     style={"display": "inline-block", "width": "49%"},
            # ),
            # html.Div(
            #     [
            dcc.Dropdown(candles_df["ticker"].unique(), "BTC-USD", id="dropdown-selection"),
            dcc.Graph(id="ticker"),
        ],
        style={"width": "100%", "display": "inline-block"},
        # style={"width": "49%", "display": "inline-block", "padding": "0 20"},
    ),
    dcc.Graph(id="orders", figure=order_fig),
]


@callback(Output("best-worst-performers", "figure"), Input("token-group", "value"))
def update_graph_fig(basket: str) -> go.Figure:
    pairs = []

    if basket == "All":
        pairs = candles_df["ticker"].unique()
    elif basket == "Best":
        pairs = best
    elif basket == "Worst":
        pairs = worst
    elif basket == "Best&Worst":
        pairs = best + worst

    fig = px.line(
        candles_df[candles_df["ticker"].isin(pairs)],
        y="return",
        line_group="ticker",
        color="ticker",
    )

    fig.update_layout(
        xaxis_title="Time",
        yaxis_title="Returns",
        xaxis_rangeslider_visible=True,
        yaxis_tickformat="%",
        yaxis_range=[0, 2],
    )
    return fig


@callback(Output("ticker", "figure"), Input("dropdown-selection", "value"))
def update_graph(ticker: str) -> go.Figure:
    dff = candles_df[candles_df["ticker"] == ticker]
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
        xaxis_title="Time",
        yaxis_title="Price",
        xaxis_rangeslider_visible=True,
    )
    return fig


if __name__ == "__main__":
    app.run(debug=True)

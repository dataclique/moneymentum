from asyncio import run
from datetime import datetime

from perpy.dydx import (
    get_candles,
    get_all_markets,
)


tickers = run(get_all_markets())
start = datetime(2024, 8, 19)
df = run(get_candles(tickers, start=start))

# tickers = df["ticker"].unique()
# best, worst = get_bestworst(df, tickers, 5)


# app = Dash()

# order_df = run(get_order_history())

# order_df["bet"] = order_df["size"] * order_df["price"]
# order_df["bets"] = order_df.groupby("ticker")["bet"].cumsum()
# order_df["cum_bets"] = order_df["bets"] + order_df["bets"].shift(1)

# order_fig = px.area(order_df, y="cum_bets")
# order_fig.update_layout(
#     xaxis_title="Time",
#     yaxis_title="Bets",
#     xaxis_rangeslider_visible=True,
# )

# app.layout = [
#     html.H1(children="dYdX", style={"textAlign": "center"}),
#     html.Div(
#         [
#             dcc.Dropdown(
#                 ["Best&Worst", "Best", "Worst", "All"], "Best&Worst", id="token-group"
#             ),
#             dcc.Graph(id="best-worst-performers"),
#             #     ],
#             #     style={"display": "inline-block", "width": "49%"},
#             # ),
#             # html.Div(
#             #     [
#             dcc.Dropdown(df["ticker"].unique(), "BTC-USD", id="dropdown-selection"),
#             dcc.Graph(id="ticker"),
#         ],
#         style={"width": "100%", "display": "inline-block"},
#         # style={"width": "49%", "display": "inline-block", "padding": "0 20"},
#     ),
#     dcc.Graph(id="orders", figure=order_fig),
# ]


# @callback(Output("best-worst-performers", "figure"), Input("token-group", "value"))
# def update_graph_fig(basket):
#     pairs = []

#     if basket == "All":
#         pairs = df["ticker"].unique()
#     elif basket == "Best":
#         pairs = best
#     elif basket == "Worst":
#         pairs = worst
#     elif basket == "Best&Worst":
#         pairs = best + worst

#     fig = px.line(
#         df[df["ticker"].isin(pairs)],
#         y="return",
#         line_group="ticker",
#         color="ticker",
#     )

#     fig.update_layout(
#         xaxis_title="Time",
#         yaxis_title="Returns",
#         xaxis_rangeslider_visible=True,
#         yaxis_tickformat="%",
#         # yaxis_range=[0, 2],
#     )
#     return fig


# @callback(Output("ticker", "figure"), Input("dropdown-selection", "value"))
# def update_graph(ticker):
#     dff = df[df["ticker"] == ticker]
#     fig = go.Figure(
#         go.Candlestick(
#             x=dff.index,
#             open=dff["open"],
#             high=dff["high"],
#             low=dff["low"],
#             close=dff["close"],
#         )
#     )
#     fig.update_layout(
#         xaxis_title="Time",
#         yaxis_title="Price",
#         xaxis_rangeslider_visible=True,
#     )
#     return fig


# if __name__ == "__main__":
#     print("Running the dashboard...")
#     app.run(debug=True)

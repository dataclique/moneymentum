import pandas as pd
from dash import Dash, html, dcc, callback, Output, Input
import plotly.express as px
import plotly.graph_objects as go

from perpy.picks import get_bestworst
from perpy.dydx import prep_candles

df = prep_candles(pd.read_csv("./data/candles.csv"))

tickers = df["ticker"].unique()
best, worst = get_bestworst(df, tickers, 5)


app = Dash()

app.layout = [
    html.H1(children="dYdX", style={"textAlign": "center"}),
    html.Div(
        [
            dcc.Dropdown(
                ["Best&Worst", "Best", "Worst", "All"], "All", id="token-group"
            ),
            dcc.Graph(id="best-worst-performers"),
            #     ],
            #     style={"display": "inline-block", "width": "49%"},
            # ),
            # html.Div(
            #     [
            dcc.Dropdown(df["ticker"].unique(), "BTC-USD", id="dropdown-selection"),
            dcc.Graph(id="ticker"),
        ],
        style={"width": "100%", "display": "inline-block"},
        # style={"width": "49%", "display": "inline-block", "padding": "0 20"},
    ),
]


@callback(Output("best-worst-performers", "figure"), Input("token-group", "value"))
def update_graph_fig(basket):
    pairs = []

    if basket == "All":
        pairs = df["ticker"].unique()
    elif basket == "Best":
        pairs = best
    elif basket == "Worst":
        pairs = worst
    elif basket == "Best&Worst":
        pairs = best + worst

    fig = px.line(
        df[df["ticker"].isin(pairs)],
        y="return",
        line_group="ticker",
        color="ticker",
    )

    fig.update_layout(
        xaxis_title="Time",
        yaxis_title="Returns",
        xaxis_rangeslider_visible=True,
        yaxis_tickformat="%",
        # yaxis_range=[0, 2],
    )
    return fig


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
        xaxis_title="Time",
        yaxis_title="Price",
        xaxis_rangeslider_visible=True,
    )
    return fig


if __name__ == "__main__":
    print("Running the dashboard...")
    app.run(debug=True)

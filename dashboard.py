print("\n\nStarting dashboard.py\n\n")

from asyncio import run
import pandas as pd
import numpy as np
from tqdm.asyncio import tqdm_asyncio

from perpy.dydx import get_all_markets, get_candles_for_tickers, prep_candles
from perpy.viz import plot_tickers
from perpy.picks import get_bestworst


tickers = run(get_all_markets())
df = run(get_candles_for_tickers(tickers, resolution="1MIN"))


print(df.describe())
print(df)


from dash import Dash, html, dcc, callback, Output, Input
import plotly.express as px
import pandas as pd

app = Dash()

app.layout = [
    html.H1(children="dYdX", style={"textAlign": "center"}),
    dcc.Dropdown(df["ticker"].unique(), "BTC-USD", id="dropdown-selection"),
    dcc.Graph(id="graph-content"),
]


@callback(Output("graph-content", "figure"), Input("dropdown-selection", "value"))
def update_graph(value):
    dff = df[df["ticker"] == value]
    return px.line(dff, y="return")


if __name__ == "__main__":
    app.run(debug=True)

from asyncio import run
from dash import Dash, html, dcc, dash_table
import plotly.express as px
import dash_bootstrap_components as dbc

from perpy.dydx import get_candles, get_all_markets

tickers = run(get_all_markets())
df = run(get_candles(tickers))

vol_df = df.pivot(columns="ticker", values="volume_usd").dropna()
vol_df["market"] = vol_df.sum(axis=1)

vol_ratio_df = vol_df.div(vol_df["market"], axis=0)

returns_df = df.pivot(columns="ticker", values="return").dropna()
returns_df["market"] = returns_df.mul(vol_ratio_df).sum(axis=1)

cum_returns_df = returns_df.cumsum()

external_stylesheets = [dbc.themes.CERULEAN]
app = Dash(__name__, external_stylesheets=external_stylesheets)

width = 6
app.layout = dbc.Container(
    [
        dbc.Row([html.H1(children="dYdX", style={"textAlign": "center"})]),
        html.Hr(),
        dbc.Row(
            [
                dbc.Col(
                    [
                        dcc.Graph(
                            figure=px.area(cum_returns_df, y="market"),
                        ),
                    ],
                    width=width,
                ),
                dbc.Col(
                    [
                        dash_table.DataTable(
                            data=cum_returns_df.to_dict("records"),
                            page_size=10,
                            style_table={"overflowX": "auto"},
                        ),
                    ],
                    width=width,
                ),
            ]
        ),
        dbc.Row(
            [
                dbc.Col(
                    [
                        dcc.Graph(figure=px.area(vol_df, y="market")),
                    ],
                    width=width,
                ),
                dbc.Col(
                    [
                        dash_table.DataTable(
                            data=vol_df.to_dict("records"),
                            page_size=10,
                            style_table={"overflowX": "auto"},
                        ),
                    ],
                    width=width,
                ),
            ]
        ),
    ],
    fluid=True,
)


if __name__ == "__main__":
    print("Running the dashboard...")
    app.run(debug=True)

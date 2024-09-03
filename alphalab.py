from dash import Dash, html, dcc
import dash_bootstrap_components as dbc
import pandas as pd
import plotly.express as px
import plotly.graph_objs as go

from perpy.dydx import prep_candles

external_stylesheets = [dbc.themes.CERULEAN]
app = Dash(__name__, external_stylesheets=external_stylesheets)

# tickers = run(get_all_markets())
# df = run(get_candles(tickers))
df = prep_candles(pd.read_csv("./data/candles.csv"))
tickers = df["ticker"].unique()

volume_df = df.pivot(columns="ticker", values="volume_usd").dropna()

market_df = pd.DataFrame(index=volume_df.index)
market_df["volume"] = volume_df.sum(axis=1)

volume_ratio_df = volume_df.div(market_df["volume"], axis=0)

returns_df = df.pivot(columns="ticker", values="return").dropna()
returns_df["market"] = returns_df.mul(volume_ratio_df).sum(axis=1)

cum_returns_df = returns_df.cumsum()

market_df["return"] = returns_df.mul(volume_ratio_df).sum(axis=1)
market_df["cum_return"] = market_df["return"].cumsum()

rel_returns_df = returns_df.sub(market_df["return"], axis=0)

width = 6
app.layout = dbc.Container(
    [
        dbc.Row([html.H1(children="dYdX", style={"textAlign": "center"})]),
        html.Hr(),
        dcc.Graph(
            figure={
                "data": [
                    go.Scatter(
                        x=rel_returns_df.index,
                        y=rel_returns_df[col],
                        mode="lines",
                        name=col,
                    )
                    for col in rel_returns_df.columns
                ],
                "layout": go.Layout(
                    title="Cumulative Returns Over Time",
                    xaxis={
                        "title": "Date",
                        "rangeslider": {"visible": True},
                    },
                    yaxis={"title": "Cumulative Return"},
                ),
            }
        ),
        dcc.Graph(
            figure={
                "data": [
                    go.Scatter(
                        x=cum_returns_df.index,
                        y=cum_returns_df[col],
                        mode="lines",
                        name=col,
                    )
                    for col in cum_returns_df.columns
                ],
                "layout": go.Layout(
                    title="Cumulative Returns Over Time",
                    xaxis={"title": "Date"},
                    yaxis={"title": "Cumulative Return"},
                ),
            }
        ),
        dbc.Row(
            [
                dbc.Col(
                    [
                        dcc.Graph(
                            figure=px.area(market_df, y="cum_return"),
                        ),
                    ],
                    width=width,
                ),
                dbc.Col(
                    [
                        dcc.Graph(figure=px.area(market_df, y="volume")),
                    ],
                    width=width,
                ),
            ]
        ),
        # dbc.Row(
        #     [
        #         dbc.Col(
        #             [
        # dash_table.DataTable(
        #     data=cum_returns_df.to_dict("records"),
        #     page_size=10,
        #     style_table={"overflowX": "auto"},
        # ),
        #             ],
        #             width=width,
        #         ),
        #         dbc.Col(
        #             [
        #                 dash_table.DataTable(
        #                     data=volume_df.to_dict("records"),
        #                     page_size=10,
        #                     style_table={"overflowX": "auto"},
        #                 ),
        #             ],
        #             width=width,
        #         ),
        #     ]
        # ),
    ],
    fluid=True,
)


if __name__ == "__main__":
    print("Running the dashboard...")
    app.run(debug=True)

from dash import Dash, html, dcc
import dash_bootstrap_components as dbc
import pandas as pd
import plotly.express as px
import plotly.graph_objs as go
from asyncio import run

from perpy import dydx

tickers = run(dydx.get_all_markets())
df = run(dydx.get_candles(tickers))
# df = dydx.prep_candles(pd.read_csv("./data/candles.csv"))
# tickers = df["ticker"].unique()

df["return"] = df.groupby("ticker")["close"].pct_change()
print(df)
df = df.dropna()
print(df)

volume_df = df.pivot(columns="ticker", values="volume_usd")

market_df = pd.DataFrame(index=volume_df.index)
market_df["volume"] = volume_df.sum(axis=1)

volume_ratio_df = volume_df.div(market_df["volume"], axis=0)

returns_df = df.pivot(columns="ticker", values="return")
returns_df["market"] = returns_df.mul(volume_ratio_df).sum(axis=1)

cum_returns_df = returns_df.cumsum()

market_df["return"] = returns_df.mul(volume_ratio_df).sum(axis=1)
market_df["volatility"] = returns_df.std(axis=1)
market_df = market_df.dropna()
market_df["risk_adj_return"] = market_df["return"] / market_df["volatility"]
market_df["cum_return"] = market_df["return"].cumsum()
market_df["cum_risk_adj_return"] = market_df["risk_adj_return"].cumsum()

cov_matrix = returns_df.cov()
cov_with_market = cov_matrix.loc[:, "market"].drop("market")
market_variance = market_df["return"].var()

beta_df = cov_with_market / market_variance
beta_adjusted_returns_df = returns_df.div(beta_df, axis=1)
rel_returns_df = beta_adjusted_returns_df.cumsum()

final_cum_returns = rel_returns_df.iloc[-1]
sorted_assets = final_cum_returns.sort_values()

n_assets = len(sorted_assets)
top_10_percent = sorted_assets.iloc[-(n_assets // 10) :]  # Top 10%
bottom_10_percent = sorted_assets.iloc[: n_assets // 10]  # Bottom 10%

selected_assets = top_10_percent.index.union(bottom_10_percent.index)


external_stylesheets = [dbc.themes.CERULEAN]
app = Dash(__name__, external_stylesheets=external_stylesheets)

width = 6
app.layout = dbc.Container(
    [
        dbc.Row([html.H1(children="dYdX", style={"textAlign": "center"})]),
        html.Hr(),
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
                        dcc.Graph(figure=px.area(market_df.dropna(), y="volatility")),
                    ],
                    width=width,
                ),
                dbc.Col(
                    [
                        dcc.Graph(
                            figure=px.area(market_df, y="cum_risk_adj_return"),
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
        html.Hr(),
    ],
    fluid=True,
)


if __name__ == "__main__":
    print("Running the dashboard...")
    app.run(debug=True)

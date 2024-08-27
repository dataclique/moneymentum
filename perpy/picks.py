import pandas as pd


def get_bestworst(df, tickers, n=4):
    ticker_returns = {}
    for i, ticker in enumerate(tickers):
        candles = df[df["ticker"] == ticker]
        if candles["usdVolume"].mean() < 100:
            continue

        start_price = candles["close"].iloc[0]
        ticker_returns[ticker] = candles["close"].iloc[-1] / start_price

    returns = pd.DataFrame(
        ticker_returns.items(), columns=["ticker", "return"], index=None
    )
    returns.set_index("ticker", inplace=True)
    returns.sort_values("return", ascending=False, inplace=True)

    top = returns.head(n).index.tolist()
    bottom = returns.tail(n).index.tolist()

    return [top, bottom]

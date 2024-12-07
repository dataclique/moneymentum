import pandas as pd


def get_bestworst(
    candle_df: pd.DataFrame, tickers: list[str], n: int = 4
) -> tuple[list[str], list[str]]:
    ticker_returns = {}
    for _, ticker in enumerate(tickers):
        candles = candle_df[candle_df["ticker"] == ticker]
        MIN_VOLUME = 100
        if candles["usdVolume"].mean() < MIN_VOLUME:
            continue

        start_price = candles["close"].iloc[0]
        ticker_returns[ticker] = candles["close"].iloc[-1] / start_price

    returns = pd.DataFrame(ticker_returns.items(), columns=["ticker", "return"], index=None)
    returns = returns.set_index("ticker")
    returns = returns.sort_values("return", ascending=False)

    top = returns.head(n).index.tolist()
    bottom = returns.tail(n).index.tolist()

    return [top, bottom]

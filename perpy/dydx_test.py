from datetime import datetime, timedelta
import pandas as pd
import pytest

from perpy.dydx import get_all_markets, get_candles, prep_candles


@pytest.mark.asyncio
async def test_tickers_and_candles():
    tickers = await get_all_markets()
    assert len(tickers) > 0

    start = datetime(2024, 8, 1)
    end = datetime.utcnow().replace(second=0, microsecond=0)
    delta = timedelta(minutes=1000)
    expected_candles_per_ticker = (end - start).total_seconds() // 120

    candles = await get_candles(tickers[:2], start=start)
    assert candles is not None

    print(candles)
    assert candles.index[0] == pd.Timestamp(start, tz="UTC")
    assert candles.index[-1] == pd.Timestamp(end, tz="UTC")
    # assert candles[candles["ticker"] == tickers[0]].size == expected_candles_per_ticker
    # assert candles[candles["ticker"] == tickers[1]].size == expected_candles_per_ticker

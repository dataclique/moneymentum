from datetime import datetime
import pandas as pd
import pytest

from perpy.dydx import get_all_markets, get_candles


@pytest.mark.asyncio
async def test_tickers_and_candles():
    tickers = await get_all_markets()
    assert len(tickers) > 0

    start = datetime(2024, 8, 25)
    end = datetime.utcnow().replace(second=0, microsecond=0)
    candles = await get_candles(tickers[:2], start=start)

    assert candles is not None
    assert candles.index[0] == pd.Timestamp(start, tz="UTC")
    assert candles.index[-1] == pd.Timestamp(end, tz="UTC")

    # expected_candles_per_ticker = (end - start).total_seconds() // 120
    # assert candles[candles["ticker"] == tickers[0]].size == expected_candles_per_ticker
    # assert candles[candles["ticker"] == tickers[1]].size == expected_candles_per_ticker

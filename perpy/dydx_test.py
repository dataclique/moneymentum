from perpy.dydx import get_all_markets, get_candles

import pytest


@pytest.mark.asyncio
async def test_tickers_and_candles():
    tickers = await get_all_markets()
    assert len(tickers) > 0

    candles = await get_candles(tickers[:2], days=7)
    assert candles is not None

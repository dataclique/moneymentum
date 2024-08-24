import asyncio
from dydx_v4_client.indexer.rest.indexer_client import IndexerClient
from dydx_v4_client.network import make_mainnet

NODE_URL = "https://dydx-rpc.publicnode.com:443"
INDEXER_REST_URL = "https://indexer.dydx.trade"
INDEXER_WEBSOCKET_URL = "wss://indexer.dydx.trade/v4/ws"

MAINNET = make_mainnet(
    node_url=NODE_URL,
    rest_indexer=INDEXER_REST_URL,
    websocket_indexer=INDEXER_WEBSOCKET_URL,
)


async def setup_client():
    return IndexerClient(MAINNET.rest_indexer)


client = asyncio.run(setup_client())


async def get_all_markets():
    response = await client.markets.get_perpetual_markets()
    print(response)


asyncio.run(get_all_markets())


async def get_candles():
    response = await client.markets.get_perpetual_market_candles(
        market="BTC-USD", resolution="1MIN"
    )
    candles = response["candles"]
    if candles:
        latest_candle = candles[0]
        print(
            f"Latest candle: Open {latest_candle['open']}, Close {latest_candle['close']}, High {latest_candle['high']}, Low {latest_candle['low']}"
        )


asyncio.run(get_candles())

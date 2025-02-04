import logging
from dataclasses import dataclass

import pandas as pd
from ccxt import async_support as ccxt
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import types as T

from yang import util

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


SchemaPerpMarket = T.StructType(
    [
        T.StructField("id", T.StringType()),
        T.StructField("symbol", T.StringType()),
        T.StructField("base", T.StringType()),
        T.StructField("quote", T.StringType()),
        T.StructField("settle", T.StringType()),
        T.StructField("type", T.StringType()),
        T.StructField("subType", T.StringType()),
        T.StructField("taker", T.DoubleType()),
        T.StructField("maker", T.DoubleType()),
        T.StructField("maxLeverage", T.IntegerType()),
        T.StructField("funding", T.DoubleType()),
        T.StructField("openInterest", T.DoubleType()),
        T.StructField("markPx", T.DoubleType()),
    ]
)


@dataclass
class HyperliquidDataLoaderMarkets:
    spark: SparkSession
    reload = False

    async def fetch_markets(
        self,
        exchange: ccxt.Exchange,
    ) -> DataFrame:
        """Fetch all perpetual symbols from the exchange."""

        if not self.reload:
            return self.spark.read.csv("data/markets.csv", schema=SchemaPerpMarket, header=True)

        logger.info("Fetching markets...")
        markets = await exchange.load_markets()

        symbols = frozenset(markets.keys())
        perp_symbols = frozenset(
            filter(
                lambda s: (
                    markets[s].get("type") == "swap"
                    and markets[s].get("spot") is False
                    and markets[s].get("active") is True
                    and markets[s].get("settle") == "USDC"
                ),
                symbols,
            )
        )
        markets = [
            {
                "id": markets[symbol]["id"],
                "symbol": markets[symbol]["symbol"],
                "base": markets[symbol]["base"],
                "quote": markets[symbol]["quote"],
                "settle": markets[symbol]["settle"],
                "type": markets[symbol]["type"],
                "subType": markets[symbol]["subType"],
                "taker": float(markets[symbol]["taker"]),
                "maker": float(markets[symbol]["maker"]),
                "maxLeverage": int(markets[symbol]["info"]["maxLeverage"]),
                "funding": float(markets[symbol]["info"]["funding"]),
                "openInterest": float(markets[symbol]["info"]["openInterest"]),
                "markPx": float(markets[symbol]["info"]["markPx"]),
            }
            for symbol in perp_symbols
        ]

        logger.info("Found %s perpetual symbols", len(perp_symbols))

        markets_pdf = pd.DataFrame(markets)
        markets_df = self.spark.createDataFrame(markets_pdf, schema=SchemaPerpMarket)

        util.save_csv("markets", markets_df)
        return markets_df

import logging
from dataclasses import dataclass
from pathlib import Path

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
        T.StructField("deprecated", T.BooleanType()),
    ]
)


@dataclass
class HyperliquidDataLoaderMarkets:
    spark: SparkSession

    async def fetch_markets(self, exchange: ccxt.Exchange, *, reload: bool) -> DataFrame:
        """Fetch all perpetual symbols from the exchange."""

        market_path = f"{util.DATA_DIR}/markets.csv"

        if not reload and Path(market_path).exists():
            return self.spark.read.csv(market_path, schema=SchemaPerpMarket, header=True)

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
                "deprecated": False,
            }
            for symbol in perp_symbols
        ]

        logger.info("Found %s perpetual symbols", len(perp_symbols))

        markets_pdf = pd.DataFrame(markets)

        if Path(market_path).exists():
            old_df = self.spark.read.csv(market_path, schema=SchemaPerpMarket, header=True)
            old_deprecated_status_df = old_df.select("symbol", "deprecated")
            old_deprecated_status_pdf = old_deprecated_status_df.toPandas()

            merged_df = markets_pdf.merge(
                old_deprecated_status_pdf, on="symbol", suffixes=("_old", "_new"), how="left"
            )

            markets_pdf["deprecated"] = merged_df["deprecated_new"].fillna(
                markets_pdf["deprecated"]
            )

        markets_df = self.spark.createDataFrame(markets_pdf, schema=SchemaPerpMarket)

        util.save_csv("markets", markets_df)
        return markets_df

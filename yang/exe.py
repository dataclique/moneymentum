import logging
import os
from dataclasses import dataclass
from typing import Literal

import ccxt  # type: ignore[import-untyped]
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T
from tenacity import retry, stop_after_attempt, wait_exponential

from yang import util

logger = logging.getLogger(__name__)
logger.setLevel(util.LOG_LEVEL)


def _get_hyperliquid(
    vault_address: str = "0xb796084efac92e2785fcc3bd7eef71e79f065ec6",
) -> tuple[ccxt.Exchange, dict]:
    from dotenv import load_dotenv

    load_dotenv()
    secret = os.getenv("HYPERLIQUID_API_SECRET")

    exchange = ccxt.hyperliquid(
        {
            "walletAddress": vault_address,
            "privateKey": secret,
            "timeout": 10000,  # 3 seconds
            "enableRateLimit": True,
            "options": {
                "defaultSlippage": 0.015,  # slipage 1.5%
                "defaultType": "swap",  # Specify the market type if necessary
            },
            "rateLimit": 20,  # Adjust rate limit if necessary
        }
    )

    params = {"vaultAddress": vault_address}
    return exchange, params


SchemaPerpPosition = T.StructType(
    [
        T.StructField("symbol", T.StringType()),
        T.StructField("isolated", T.BooleanType()),
        T.StructField("side", T.StringType()),
        # T.StructField("contracts", T.DoubleType()),
        # T.StructField("contractSize", T.DoubleType()),
        T.StructField("entryPrice", T.DoubleType()),
        T.StructField("notional", T.DoubleType()),
        T.StructField("leverage", T.DoubleType()),
        T.StructField("collateral", T.DoubleType()),
        T.StructField("initialMargin", T.DoubleType()),
        T.StructField("unrealizedPnl", T.DoubleType()),
        T.StructField("liquidationPrice", T.DoubleType()),
        T.StructField("percentage", T.DoubleType()),
    ]
)


@dataclass
class ExecutionEngine:
    spark: SparkSession
    min_position_size_usd: float
    leverage: int
    exchange, params = _get_hyperliquid()

    def get_balance(self) -> float:
        return self.exchange.fetch_balance()["total"]["USDC"]

    @retry(
        stop=stop_after_attempt(10),
        wait=wait_exponential(multiplier=1.1, min=0.25, max=10),
        reraise=True,
    )
    def get_positions(self) -> DataFrame:
        fetched_positions = self.exchange.fetch_positions()
        positions = [
            {
                "symbol": position["symbol"],
                "isolated": position["isolated"],
                "side": position["side"],
                # "contracts": float(position["contracts"]),
                # "contractSize": float(position["contractSize"]),
                "entryPrice": float(position["entryPrice"]),
                "notional": float(position["notional"]),
                "leverage": float(position["leverage"]),
                "collateral": float(position["collateral"]),
                "initialMargin": float(position["initialMargin"]),
                "unrealizedPnl": float(position["unrealizedPnl"]),
                "liquidationPrice": float(position["liquidationPrice"])
                if position["liquidationPrice"]
                else None,
                "percentage": float(position["percentage"]),
            }
            for position in fetched_positions
        ]

        positions_df = self.spark.createDataFrame(positions, schema=SchemaPerpPosition)  # type: ignore[type-var]
        logger.info("Fetched %d positions: ", len(positions))
        positions_df.show()
        return positions_df

    @retry(
        stop=stop_after_attempt(10),
        wait=wait_exponential(multiplier=1.1, min=0.25, max=10),
        reraise=True,
    )
    def place_trade(
        self,
        symbol: str,
        order_type: Literal["market", "limit"],
        side: Literal["buy", "sell"],
        amount: float,
        price: float,
    ) -> None:
        try:
            logger.info("Setting leverage to %d", self.leverage)
            self.exchange.set_leverage(symbol=symbol, leverage=self.leverage, params=self.params)

            # Quantize amount to 3 significant figures
            quantized_amount = float(f"{amount:.3g}")

            logger.debug(
                "Placing %s %s order for %s of %s at %s...",
                order_type,
                side,
                quantized_amount,
                symbol,
                price,
            )
            self.exchange.create_order(
                symbol,
                type=order_type,
                side=side,
                amount=quantized_amount,
                price=price,
                params=self.params,
            )
            logger.info(
                "Placed %s %s order for %s of %s at %s",
                order_type,
                side,
                quantized_amount,
                symbol,
                price,
            )
        except Exception:
            logger.exception(
                "Error placing a %s %s order for %s of %s at %s",
                order_type,
                side,
                quantized_amount,
                symbol,
                price,
            )

    def _handle_position_changes(self, portfolio_updates: DataFrame) -> None:
        closings = portfolio_updates.filter(F.col("action") == "close")
        for row in closings.collect():
            logger.info("Closing %s %s...", row.symbol, row.direction.upper())

            try:
                ticker = self.exchange.fetch_ticker(row.symbol)
                close_price = ticker["last"] if ticker["last"] else ticker["close"]

                self.place_trade(
                    symbol=row.symbol,
                    side="sell" if row.direction == "long" else "buy",
                    order_type="market",
                    amount=row.current_size / close_price,
                    price=close_price,
                )
            except Exception:
                logger.exception(
                    "Error fetching price or closing position for %s",
                    row.symbol,
                )

        # Handle updates
        position_updates = portfolio_updates.filter(F.col("action") == "update")
        for row in position_updates.collect():
            diff = row.target_size - row.current_size
            diff_position_size = diff / row.close

            if abs(diff) > self.min_position_size_usd:
                logger.info("Updating %s: %s", row.symbol, diff_position_size)

                is_buy = (row.direction == "long" and diff > 0) or (
                    row.direction == "short" and diff < 0
                )
                self.place_trade(
                    symbol=row.symbol,
                    order_type="market",
                    side="buy" if is_buy else "sell",
                    amount=abs(diff_position_size),
                    price=row.close,
                )

        # Handle openings
        openings = portfolio_updates.filter(F.col("action") == "open")
        for row in openings.collect():
            logger.info("Opening %s %s...", row.symbol, row.direction.upper())
            self.place_trade(
                symbol=row.symbol,
                order_type="market",
                side="buy" if row.direction == "long" else "sell",
                amount=row.target_size / row.close,
                price=row.close,
            )

    def rebalance(self, target_portfolio: DataFrame) -> None:
        current_portfolio = self.get_positions()

        # Log the initial size of target portfolio
        logger.info("Initial target portfolio size: %d", target_portfolio.count())

        # Log key metrics statistics
        target_portfolio.select(
            F.min("price_zscore").alias("min_zscore"),
            F.max("price_zscore").alias("max_zscore"),
            # Add other relevant metrics
        ).show()

        # Create a DataFrame of all position changes
        current_positions = current_portfolio.select(
            "symbol",
            F.col("side").alias("direction"),
            F.col("notional").alias("current_size"),
        )

        target_positions = target_portfolio.select(
            "symbol",
            "direction",
            F.col("position_size").alias("target_size"),
            "close",
        )

        # Log sizes at each step
        logger.info("Current positions size: %d", current_positions.count())
        logger.info("Target positions size: %d", target_positions.count())

        # Join current and target positions
        portfolio_updates = (
            target_positions.join(current_positions, ["symbol", "direction"], "full_outer")
            .withColumn("current_size", F.coalesce(F.col("current_size"), F.lit(0.0)))
            .withColumn("target_size", F.coalesce(F.col("target_size"), F.lit(0.0)))
            .withColumn(
                "action",
                F.when(F.col("current_size") == 0, "open")
                .when(F.col("target_size") == 0, "close")
                .otherwise("update"),
            )
        )

        logger.info("Portfolio updates:")
        portfolio_updates.show()

        # Handle all position changes
        self._handle_position_changes(portfolio_updates)

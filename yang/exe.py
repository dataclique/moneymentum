import logging
import os
from dataclasses import dataclass
from typing import Literal

import ccxt
from dotenv import load_dotenv
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
    """
    Initialize Hyperliquid exchange connection via CCXT.

    Args:
        vault_address: Hyperliquid vault address for trading (default: specified vault)

    Returns:
        Tuple of (exchange instance, params dict for vault trading)

    Note:
        Requires HYPERLIQUID_API_SECRET environment variable to be set
    """
    load_dotenv()
    secret = os.getenv("HYPERLIQUID_API_SECRET")

    exchange = ccxt.hyperliquid(
        {
            "walletAddress": vault_address,
            "privateKey": secret,
            "timeout": 10000,  # 3 seconds
            "enableRateLimit": True,
            "rateLimit": 20,  # Adjust rate limit if necessary
            "options": {
                "defaultSlippage": 0.015,  # slipage 1.5%
                "defaultType": "swap",  # Specify the market type if necessary
            },
        }
    )

    params = {"vaultAddress": vault_address}
    return exchange, params


SchemaPerpPosition = T.StructType(
    [
        T.StructField("symbol", T.StringType()),
        T.StructField("isolated", T.BooleanType()),
        T.StructField("side", T.StringType()),
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
class Order:
    """Specification of a single trade order.

    By wrapping the individual parameters in a dataclass we reduce the number
    of positional arguments that :py:meth:`ExecutionEngine.place_trade` needs
    to accept, eliminating Ruff's PLR0913 lint error.
    """

    symbol: str
    order_type: Literal["market", "limit"]
    side: Literal["buy", "sell"]
    amount: float
    price: float


@dataclass
class ExecutionEngine:
    """
    Trade execution engine for Hyperliquid perpetual futures exchange.

    Manages portfolio rebalancing by comparing target positions from strategy signals
    with current positions, then executing trades via CCXT to reconcile differences.
    Includes retry logic and rate limiting for reliable order placement.

    Attributes:
        spark: PySpark session for DataFrame operations
        min_position_size_usd: Minimum position size in USD (positions below this are filtered)
        leverage: Leverage multiplier for all positions (e.g., 3 for 3x leverage)
        exchange: CCXT Hyperliquid exchange instance
        params: Additional parameters for vault trading
    """

    spark: SparkSession
    min_position_size_usd: float
    leverage: int
    exchange, params = _get_hyperliquid()

    def get_balance(self) -> float:
        """Fetch current USDC balance from Hyperliquid."""
        return self.exchange.fetch_balance()["total"]["USDC"]

    @retry(
        stop=stop_after_attempt(10),
        wait=wait_exponential(multiplier=1.1, min=0.25, max=10),
        reraise=True,
    )
    def get_positions(self) -> DataFrame:
        """
        Fetch current perpetual positions from Hyperliquid exchange.

        Retrieves all open positions with details including entry price, notional value,
        leverage, collateral, unrealized PnL, and liquidation price. Retries up to 10
        times with exponential backoff on failure.

        Returns:
            PySpark DataFrame with columns:
                - symbol: Trading pair (e.g., "BTC/USDC:USDC")
                - isolated: Whether position uses isolated margin
                - side: Position direction ("long" or "short")
                - entryPrice: Average entry price
                - notional: Position size in USD
                - leverage: Current leverage multiplier
                - collateral: Margin collateral amount
                - initialMargin: Initial margin requirement
                - unrealizedPnl: Unrealized profit/loss
                - liquidationPrice: Price at which position liquidates
                - percentage: PnL percentage
        """
        fetched_positions = self.exchange.fetch_positions()
        positions = [
            {
                "symbol": position["symbol"],
                "isolated": position["isolated"],
                "side": position["side"],
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
    def place_trade(self, order: Order) -> None:
        """
        Execute a single trade order on Hyperliquid exchange.

        Sets leverage, quantizes the order amount to 3 significant figures, and submits
        the order via CCXT. Retries up to 10 times with exponential backoff on failure.

        Args:
            order: Order specification containing symbol, type, side, amount, and price

        Raises:
            Exception: Logs and re-raises any exception encountered during order placement
        """
        try:
            logger.info("Setting leverage to %d", self.leverage)
            self.exchange.set_leverage(
                symbol=order.symbol, leverage=self.leverage, params=self.params
            )

            # Quantize amount to 3 significant figures
            quantized_amount = float(f"{order.amount:.3g}")

            logger.debug(
                "Placing %s %s order: %s units of %s at %s",
                order.order_type,
                order.side,
                quantized_amount,
                order.symbol,
                order.price,
            )
            self.exchange.create_order(
                order.symbol,
                type=order.order_type,
                side=order.side,
                amount=quantized_amount,
                price=order.price,
                params=self.params,
            )
            logger.info(
                "Placed %s %s order for %s of %s at %s",
                order.order_type,
                order.side,
                quantized_amount,
                order.symbol,
                order.price,
            )
        except Exception:
            logger.exception(
                "Error placing a %s %s order for %s of %s at %s",
                order.order_type,
                order.side,
                quantized_amount,
                order.symbol,
                order.price,
            )

    def _handle_position_changes(self, portfolio_updates: DataFrame) -> None:
        """
        Execute trades to reconcile current positions with target portfolio.

        Processes three types of actions:
        1. Close: Fully close positions that are not in target portfolio
        2. Update: Adjust size of existing positions (if diff > min_position_size_usd)
        3. Open: Create new positions for assets in target but not current portfolio

        Args:
            portfolio_updates: DataFrame with columns:
                - symbol, direction, current_size, target_size, close, action
        """
        closings = portfolio_updates.filter(F.col("action") == "close")
        for row in closings.collect():
            logger.info("Closing %s %s...", row.symbol, row.direction.upper())

            try:
                ticker = self.exchange.fetch_ticker(row.symbol)
                close_price = ticker["last"] if ticker["last"] else ticker["close"]

                self.place_trade(
                    Order(
                        symbol=row.symbol,
                        order_type="market",
                        side="sell" if row.direction == "long" else "buy",
                        amount=row.current_size / close_price,
                        price=close_price,
                    )
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
                    Order(
                        symbol=row.symbol,
                        order_type="market",
                        side="buy" if is_buy else "sell",
                        amount=abs(diff_position_size),
                        price=row.close,
                    )
                )

        # Handle openings
        openings = portfolio_updates.filter(F.col("action") == "open")
        for row in openings.collect():
            logger.info("Opening %s %s...", row.symbol, row.direction.upper())
            self.place_trade(
                Order(
                    symbol=row.symbol,
                    order_type="market",
                    side="buy" if row.direction == "long" else "sell",
                    amount=row.target_size / row.close,
                    price=row.close,
                )
            )

    def rebalance(self, target_portfolio: DataFrame) -> None:
        """
        Rebalance portfolio to match target positions from strategy.

        Workflow:
        1. Fetch current positions from exchange
        2. Compare with target portfolio from strategy signals
        3. Determine required actions (open/close/update) via full outer join
        4. Execute trades to reconcile differences

        Args:
            target_portfolio: DataFrame with columns:
                - symbol: Trading pair
                - direction: "long" or "short"
                - position_size: Target position size in USD
                - close: Current market price
        """
        current_portfolio = self.get_positions()
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
        logger.info("Current portfolio size: %d", current_positions.count())
        logger.info("Target portfolio size: %d", target_positions.count())

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

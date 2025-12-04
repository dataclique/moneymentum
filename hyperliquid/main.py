import logging
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

# Add parent directory to path to allow imports when running from hyperliquid folder
parent_dir = Path(__file__).parent.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

import ccxt  # type: ignore[import] # noqa: E402
from ccxt.base.errors import ExchangeError  # type: ignore[import] # noqa: E402

from hyperliquid.settings import UserSettings  # noqa: E402

logger = logging.getLogger(__name__)

OrderSide = Literal["buy", "sell"]
Status = Literal["untouched", "modified", "deleted", "idle"]
MIN_ORDER_VALUE = 10.0


def _is_testnet() -> bool:
    """Check if we should use testnet based on PROD environment variable."""
    return os.getenv("PROD", "").lower() != "true"


@dataclass
class Position:
    """
    Represents a position from the exchange.
    """

    symbol: str
    percentage: float
    side: OrderSide
    leverage: int
    status: Status


class Trader:
    public_key: str
    secret_key: str
    leverage: int

    def __init__(self, settings: UserSettings) -> None:
        self.public_key = settings.public_key
        self.secret_key = settings.secret_key

        # self.leverage = settings.trade.leverage TODO: Add leverage

        is_testnet = _is_testnet()
        if is_testnet:
            logger.debug(
                "Using wallet address: %s...%s", self.public_key[:10], self.public_key[-10:]
            )

        self._initialize_exchange()

        logger.info("Initialized Trader")

    def _initialize_exchange(self) -> None:
        """Initialize the ccxt exchange instance."""
        is_testnet = _is_testnet()

        ccxt_config = {
            "walletAddress": self.public_key,
            "privateKey": self.secret_key,
            "enableRateLimit": True,
        }

        self.exchange = ccxt.hyperliquid(ccxt_config)
        if is_testnet:
            self.exchange.set_sandbox_mode(True)
            logger.debug("Running in testnet mode, using testnet URLs.")
            ccxt_config["urls"] = {
                "api": {
                    "public": "https://api.hyperliquid-testnet.xyz",
                    "private": "https://api.hyperliquid-testnet.xyz",
                }
            }
        else:
            logger.debug("Running in mainnet mode, using production URLs.")

        self.exchange.verbose = False
        self.exchange.options["builderFee"] = False
        self.exchange.options["approvedBuilderFee"] = False
        self.exchange.options["defaultSlippage"] = 0.05  # 5% slippage as number
        self.exchange.load_markets()

    def _set_leverage(self, symbol: str, leverage: int) -> None:
        """Set leverage for a symbol. Raises ExchangeError on failure."""
        self.exchange.set_leverage(leverage, symbol)
        logger.info("Set leverage for %s to %sx", symbol, leverage)

    def _fetch_symbol_prices(self, symbols: set[str]) -> dict[str, float]:
        if not symbols:
            return {}
        prices: dict[str, float] = {}
        # Make a single API call to fetch all tickers
        all_tickers = self.exchange.fetch_tickers(list(symbols))

        for symbol in symbols:
            ticker = all_tickers.get(symbol)
            if ticker is None or ticker.get("last") is None:
                msg = (
                    f"Could not fetch price for {symbol}. The asset may be untradable or delisted."
                )
                raise ValueError(msg)

            last_price = float(ticker["last"])
            if last_price <= 0:
                msg = f"Invalid price for {symbol}: {last_price}"
                raise ValueError(msg)
            prices[symbol] = last_price
        return prices

    def _signed_notional(self, *, side: OrderSide, notional: float) -> float:
        return notional if side == "buy" else -notional

    def _place_market_order(
        self,
        *,
        symbol: str,
        side: OrderSide,
        usd_value: float,
        price: float,
        reduce_only: bool,
    ) -> tuple[str, str | None]:
        if usd_value <= 0 or price <= 0:
            return "failed", "Invalid order parameters"
        if usd_value < MIN_ORDER_VALUE:
            return (
                "failed",
                f"Requested notional ${usd_value:.2f} is below minimum ${MIN_ORDER_VALUE}",
            )

        amount = usd_value / price
        params = {"reduceOnly": True} if reduce_only else {}

        try:
            response = self.exchange.create_order(
                symbol,
                "market",
                side,
                amount,
                price=price,
                params=params,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Order for %s failed", symbol)
            return "failed", str(exc)

        status = self._normalize_order_status(response)
        return status, None

    def get_balance(self) -> float:
        """Get the current balance of the account."""
        balance = self.exchange.fetch_balance()
        return float(balance["total"]["USDC"])

    def get_available_budget(self) -> float:
        """Return available perpetual USDC balance."""
        return self.get_balance()

    def list_perp_tickers(self) -> list[str]:
        """Return all perpetual symbols supported by Hyperliquid."""
        markets = self.exchange.load_markets()
        perp_symbols = [
            symbol for symbol, data in markets.items() if ":" in symbol and data.get("swap")
        ]
        return sorted(perp_symbols)

    def get_perp_max_leverage(self) -> list[dict[str, Any]]:
        """
        Return max leverage for each perpetual symbol.

        Uses `fetch_tickers()` so structure matches what we see in all_tickers.json.
        Falls back to 1x when leverage is missing or malformed.
        """
        tickers = self.exchange.fetch_tickers()
        results: list[dict[str, Any]] = []
        for symbol, ticker in tickers.items():
            # Perps are the symbols with ":" (e.g. "BTC/USDC:USDC")
            if ":" not in symbol:
                continue
            info = ticker.get("info") or {}
            raw_max_lev = info.get("maxLeverage")
            try:
                max_leverage = float(raw_max_lev) if raw_max_lev is not None else 1.0
            except (TypeError, ValueError):
                max_leverage = 1.0
            results.append({"symbol": symbol, "max_leverage": max_leverage})

        # Keep ordering deterministic for frontend
        results.sort(key=lambda item: item["symbol"])
        return results

    def get_current_positions(self) -> list[dict[str, Any]]:
        """Fetch current open positions from Hyperliquid."""
        positions = self.exchange.fetch_positions()
        processed = []
        for pos in positions:
            try:
                notional_raw = pos.get("notional")
                if notional_raw is None or float(notional_raw) <= 0:
                    continue

                entry_price_raw = pos.get("entryPrice")
                pnl_raw = pos.get("unrealizedPnl")
                leverage_raw = pos.get("leverage")

                processed.append(
                    {
                        "symbol": pos["symbol"],
                        "side": "buy" if pos["side"] == "long" else "sell",
                        "notional": float(notional_raw),
                        "entryPrice": float(entry_price_raw)
                        if entry_price_raw is not None
                        else 0.0,
                        "unrealizedPnl": float(pnl_raw) if pnl_raw is not None else 0.0,
                        "leverage": int(leverage_raw) if leverage_raw is not None else 1,
                    }
                )
            except (TypeError, ValueError, KeyError) as e:
                logger.warning(
                    "Could not parse position from exchange: %s. Error: %s. Skipping.", pos, e
                )
                continue
        return processed

    def open_positions(self, positions: list[Position], budget: float) -> list[dict[str, Any]]:
        """Open positions based on the given positions and budget."""
        if not positions:
            return []

        symbols = [pos.symbol for pos in positions]
        logger.info("Fetching tickers for %d symbols...", len(symbols))

        tickers: dict[str, float] = {}
        for symbol in symbols:
            # TODO: we can do fetch_tickers(symbols) instead
            ticker = self.exchange.fetch_ticker(symbol)
            tickers[symbol] = float(ticker["last"])
            logger.debug("  %s: %s", symbol, tickers[symbol])

        order_results: list[dict[str, Any]] = []
        logger.info("Creating %d orders...", len(positions))
        for position in positions:
            # Set leverage before opening position
            self._set_leverage(position.symbol, position.leverage)

            current_price = tickers[position.symbol]
            amount = position.percentage * budget / current_price

            min_order_value = 10.0
            if position.percentage * budget < min_order_value:
                msg = (
                    f"Skipped {position.symbol}: allocation "
                    f"{position.percentage * budget:.2f} < ${min_order_value}"
                )
                logger.warning(msg)
                order_results.append(
                    {
                        "symbol": position.symbol,
                        "side": position.side,
                        "percentage": position.percentage,
                        "status": "failed",
                        "message": msg,
                    }
                )
                continue

            logger.info(
                "  %s %s of %s at %s", position.side, amount, position.symbol, current_price
            )

            try:
                response = self.exchange.create_order(
                    position.symbol,
                    "market",
                    position.side,
                    amount,
                    price=current_price,  # Required for Hyperliquid slippage calculation
                )
                status = self._normalize_order_status(response)
                order_results.append(
                    {
                        "symbol": position.symbol,
                        "side": position.side,
                        "percentage": position.percentage,
                        "status": status,
                        "message": None,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                error_msg = f"Order for {position.symbol} failed: {exc}"
                logger.exception(error_msg)
                order_results.append(
                    {
                        "symbol": position.symbol,
                        "side": position.side,
                        "percentage": position.percentage,
                        "status": "failed",
                        "message": error_msg,
                    }
                )

        return order_results

    def _close_position(self, original_position: Position) -> dict[str, Any]:
        """Close a position for a symbol using a reduce-only market order."""
        symbol = original_position.symbol

        # Fetch price before entering the try block to avoid TRY301
        ticker = self.exchange.fetch_ticker(symbol)
        current_price = ticker.get("last")
        if current_price is None:
            err_msg = f"Could not fetch price for {symbol} to close position."
            raise ValueError(err_msg)
        try:
            # 1. Fetch current position from the exchange
            positions = self.exchange.fetch_positions([symbol])
            if not positions or float(positions[0].get("contracts", 0)) == 0:
                return {
                    "symbol": symbol,
                    "status": "filled",
                    "message": "Position already closed.",
                    "side": original_position.side,
                    "percentage": 0.0,
                }

            position = positions[0]
            side = "sell" if position["side"] == "long" else "buy"
            amount = float(position["contracts"])

            # 2. Calculate a slippage price to protect the market order
            slippage = 0.05  # 5%
            if side == "buy":  # Closing a short
                slippage_price = current_price * (1 + slippage)
            else:  # Closing a long
                slippage_price = current_price * (1 - slippage)

            # 3. Create a reduce-only market order with a slippage price
            self.exchange.create_order(
                symbol,
                "market",
                side,
                amount,
                slippage_price,
                params={"reduceOnly": True},
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to close position for %s", symbol)
            return {
                "symbol": symbol,
                "status": "failed",
                "message": str(exc),
                "side": original_position.side,
                "percentage": original_position.percentage,
            }
        else:
            logger.info("Submitted close order for %s", symbol)
            return {
                "symbol": symbol,
                "status": "filled",
                "side": original_position.side,
                "percentage": 0.0,
            }

    def _set_leverages(
        self,
        positions: list[Position],
    ) -> tuple[list[dict[str, Any]], list[Position]]:
        """Set leverage for all positions and return failures and successes."""
        results: list[dict[str, Any]] = []
        successful_positions: list[Position] = []
        summaries: dict[str, dict[str, Any]] = {}

        for position in positions:
            try:
                self._set_leverage(position.symbol, position.leverage)
            except ExchangeError as exc:  # noqa: PERF203
                logger.exception("Failed to set leverage for %s", position.symbol)
                original_error = getattr(exc, "args", [""])[0]
                message = str(exc)
                if "response" in original_error:
                    try:
                        import json

                        error_details = json.loads(
                            original_error.replace("hyperliquid ", ""),
                        )
                        message = error_details.get("response", str(exc))
                    except (json.JSONDecodeError, TypeError):
                        pass

                summary = summaries.setdefault(
                    position.symbol,
                    {
                        "symbol": position.symbol,
                        "side": position.side,
                        "percentage": position.percentage,
                    },
                )
                summary["status"] = "failed"
                summary["message"] = message
                results.append(summary)
            else:
                successful_positions.append(position)
        return results, successful_positions

    def rebalance_positions(
        self,
        positions: list[Position],
        budget: float,
    ) -> list[dict[str, Any]]:
        """Adjust live positions to match the requested allocation."""
        if budget <= 0:
            msg = "Budget must be positive"
            raise ValueError(msg)

        results: list[dict[str, Any]] = []
        # All positions that are not explicitly 'untouched' will be processed.
        # This includes 'deleted' positions, which will be treated as a rebalance to 0.
        positions_to_rebalance = [p for p in positions if p.status != "untouched"]

        # Handle deletions
        for p in positions:
            if p.status == "deleted":
                close_result = self._close_position(p)
                results.append(close_result)

        positions_to_rebalance = [p for p in positions_to_rebalance if p.status != "deleted"]

        if not positions_to_rebalance:
            return results

        # Set leverages and handle any immediate failures
        leverage_failures, successful_positions = self._set_leverages(
            positions_to_rebalance,
        )
        results.extend(leverage_failures)

        if not successful_positions:
            return results

        # Proceed with rebalancing for successful positions
        target_notional = self._build_target_notional(successful_positions, budget)
        current_notional = self._fetch_current_notional()
        symbols = set(current_notional.keys()) | set(target_notional.keys())
        summaries = self._initialize_summaries(successful_positions, target_notional)

        if not symbols:
            return results

        prices = self._fetch_symbol_prices(list(symbols))

        for symbol in symbols:
            price = prices.get(symbol)
            if price is None:
                error_msg = f"Could not fetch price for {symbol}"
                logger.error(error_msg)
                results.append({"symbol": symbol, "status": "failed", "message": error_msg})
                continue

            summary = summaries.get(symbol)
            self._rebalance_symbol(
                symbol=symbol,
                price=price,
                target_value=target_notional.get(symbol, 0.0),
                current_value=current_notional.get(symbol, 0.0),
                summary_entry=summary,
            )
        return results

    def _build_target_notional(
        self,
        positions: list[Position],
        budget: float,
    ) -> dict[str, float]:
        return {
            pos.symbol: self._signed_notional(side=pos.side, notional=pos.percentage * budget)
            for pos in positions
        }

    def _fetch_current_notional(self) -> dict[str, float]:
        current_positions = self.get_current_positions()
        return {
            pos["symbol"]: self._signed_notional(
                side=pos["side"], notional=float(pos.get("notional", 0.0))
            )
            for pos in current_positions
        }

    def _initialize_summaries(
        self,
        positions: list[Position],
        target_notional: dict[str, float],
        summaries: dict[str, Any] | None = None,
    ) -> dict[str, dict[str, Any]]:
        summaries = summaries if summaries is not None else {}
        percentage_lookup = {pos.symbol: pos.percentage for pos in positions}
        for symbol, notional_value in target_notional.items():
            if symbol not in summaries:
                summaries[symbol] = {
                    "symbol": symbol,
                    "side": "buy" if notional_value >= 0 else "sell",
                    "percentage": percentage_lookup.get(symbol, 0.0),
                    "status": "filled",
                    "message": None,
                }
        return summaries

    def _rebalance_symbol(
        self,
        *,
        symbol: str,
        price: float,
        target_value: float,
        current_value: float,
        summary_entry: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Place a market order to match the target notional value."""
        notional_delta = target_value - current_value

        if notional_delta == 0:
            return summary_entry

        return self._place_order(
            symbol=symbol,
            price=price,
            notional_delta=notional_delta,
            summary_entry=summary_entry,
        )

    def _place_order(
        self,
        symbol: str,
        price: float,
        notional_delta: float,
        summary_entry: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Place a market order to match the target notional value."""
        side = "buy" if notional_delta > 0 else "sell"
        coin_amount = abs(notional_delta) / price
        usd_amount = abs(notional_delta)

        min_notional = 10.0
        if usd_amount < min_notional:
            logger.warning(
                "Skipping order for %s. Requested notional $%.2f is below minimum $%.2f",
                symbol,
                usd_amount,
                min_notional,
            )
            if summary_entry:
                summary_entry["status"] = "filled"  # Treat as success
                message = (
                    f"No action taken: change (${usd_amount:.2f}) is below minimum"
                    f" order size (${min_notional:.2f})."
                )
                summary_entry["message"] = message
                return summary_entry
            return None

        logger.info(
            "Placing order: symbol=%s, side=%s, coin_amount=%s, usd_amount=%s",
            symbol,
            side,
            coin_amount,
            usd_amount,
        )

        try:
            self.exchange.create_market_order(symbol, side, coin_amount)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to place order for %s", symbol)
            if summary_entry:
                summary_entry["status"] = "failed"
                summary_entry["message"] = str(exc)
                return summary_entry
            return None
        else:
            if summary_entry:
                summary_entry["status"] = "filled"
                return summary_entry
            return None

    def _reduce_position_if_needed(
        self,
        *,
        symbol: str,
        current_value: float,
        target_value: float,
        apply_order: Callable[..., bool],
    ) -> tuple[bool, float]:
        if current_value == 0:
            return True, current_value

        same_direction = target_value != 0 and (
            (target_value > 0 and current_value > 0) or (target_value < 0 and current_value < 0)
        )
        reduce_to: float | None
        if target_value == 0:
            reduce_to = 0.0
        elif same_direction and abs(target_value) < abs(current_value):
            reduce_to = target_value
        elif not same_direction:
            reduce_to = 0.0
        else:
            reduce_to = None

        if reduce_to is None:
            return True, current_value

        reduce_usd = abs(current_value) - abs(reduce_to)
        if reduce_usd <= 0:
            return True, current_value

        reduce_side: OrderSide = "sell" if current_value > 0 else "buy"
        success = apply_order(side=reduce_side, usd_value=reduce_usd, reduce_only=True)
        if not success:
            logger.error("Reduce position order for %s failed", symbol)
        return success, reduce_to if success else current_value

    def _increase_position_if_needed(
        self,
        *,
        symbol: str,
        current_value: float,
        target_value: float,
        apply_order: Callable[..., bool],
    ) -> None:
        if target_value == current_value:
            return

        delta = target_value - current_value
        usd_needed = abs(delta)
        if usd_needed <= 0:
            return

        side: OrderSide = "buy" if delta > 0 else "sell"
        success = apply_order(side=side, usd_value=usd_needed, reduce_only=False)
        if not success:
            logger.error("Increase position order for %s failed", symbol)

    def _normalize_order_status(self, response: dict[str, Any]) -> str:
        """Translate ccxt order status into simplified frontend-friendly value."""
        info = response.get("info") or {}
        status = response.get("status") or info.get("status") or info.get("order_status")
        if not status:
            return "working"

        normalized = str(status).lower()
        if normalized in {"closed", "filled"}:
            return "filled"
        if normalized in {"canceled", "cancelled", "rejected"}:
            return "failed"
        if normalized in {"open", "partial"}:
            return "working"
        return "working"


def main() -> None:
    """Main function to get and print balance."""
    settings = UserSettings()
    trader = Trader(settings)

    # all_tickers = trader.exchange.fetch_tickers()
    # import json

    # with open("all_tickers.json", "w") as f:
    #     json.dump(all_tickers, f)

    positions = [
        Position(
            symbol="BTC/USDC:USDC", percentage=0.1, side="buy", leverage=1, status="untouched"
        ),
        Position(
            symbol="ETH/USDC:USDC", percentage=0.7, side="buy", leverage=2, status="untouched"
        ),
        Position(
            symbol="SOL/USDC:USDC", percentage=0.2, side="buy", leverage=3, status="untouched"
        ),
    ]
    trader.rebalance_positions(positions, 100)

    logger.info("Current balance: %s USDC", trader.get_balance())


if __name__ == "__main__":
    main()

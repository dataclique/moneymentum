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

    def rebalance_positions(self, positions: list[Position], budget: float) -> list[dict[str, Any]]:
        """Adjust live positions to match the requested allocation."""
        if budget <= 0:
            msg = "Budget must be positive"
            raise ValueError(msg)

        summaries = self._initialize_summaries(positions, {})
        results: list[dict[str, Any]] = []

        # First, set leverage for all positions and capture any failures
        for position in positions:
            try:
                self._set_leverage(position.symbol, position.leverage)
            except ExchangeError as exc:  # noqa: PERF203
                logger.exception("Failed to set leverage for %s", position.symbol)
                # Hyperliquid nests the real error message, so we try to extract it
                original_error = getattr(exc, "args", [""])[0]
                message = str(exc)
                if "response" in original_error:
                    try:
                        # The error message is a stringified dict
                        import json

                        error_details = json.loads(original_error.replace("hyperliquid ", ""))
                        message = error_details.get("response", str(exc))
                    except (json.JSONDecodeError, TypeError):
                        pass  # Fallback to default message

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

        # Filter out positions that already failed the leverage check
        valid_positions = [
            p for p in positions if summaries.get(p.symbol, {}).get("status") != "failed"
        ]

        target_notional = self._build_target_notional(valid_positions, budget)
        current_notional = self._fetch_current_notional()
        symbols = set(current_notional.keys()) | set(target_notional.keys())

        if not symbols:
            return results

        prices = self._fetch_symbol_prices(symbols)
        summaries = self._initialize_summaries(valid_positions, target_notional)

        for symbol, summary in summaries.items():
            price = prices.get(symbol)
            if price is None:
                logger.error("Missing price for %s, skipping rebalance", symbol)
                continue

            result = self._rebalance_symbol(
                symbol=symbol,
                price=price,
                target_value=target_notional.get(symbol, 0.0),
                current_value=current_notional.get(symbol, 0.0),
                summary_entry=summary,
            )
            # Avoid duplicating results for leverage failures
            if result is not None and result not in results:
                results.append(result)
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
        summary = summary_entry or {
            "symbol": symbol,
            "side": "buy" if target_value >= 0 else "sell",
            "percentage": 0.0,
            "status": "filled",
            "message": None,
        }
        status_rank = {"failed": 3, "working": 2, "filled": 1}

        def update_summary(status: str, message: str | None) -> None:
            normalized = status if status in status_rank else "working"
            if status_rank[normalized] >= status_rank[summary["status"]]:
                summary["status"] = normalized
                summary["message"] = message

        def apply_order(
            *,
            side: OrderSide,
            usd_value: float,
            reduce_only: bool,
        ) -> bool:
            order_status, message = self._place_market_order(
                symbol=symbol,
                side=side,
                usd_value=usd_value,
                price=price,
                reduce_only=reduce_only,
            )
            update_summary(order_status, message)
            return order_status != "failed"

        reduce_success, adjusted_value = self._reduce_position_if_needed(
            symbol=symbol,
            current_value=current_value,
            target_value=target_value,
            apply_order=apply_order,
        )
        if not reduce_success:
            return summary

        self._increase_position_if_needed(
            symbol=symbol,
            current_value=adjusted_value,
            target_value=target_value,
            apply_order=apply_order,
        )
        return summary

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
        Position(symbol="BTC/USDC:USDC", percentage=0.1, side="buy", leverage=1),
        Position(symbol="ETH/USDC:USDC", percentage=0.7, side="buy", leverage=2),
        Position(symbol="SOL/USDC:USDC", percentage=0.2, side="buy", leverage=3),
    ]
    trader.rebalance_positions(positions, 100)

    logger.info("Current balance: %s USDC", trader.get_balance())


if __name__ == "__main__":
    main()

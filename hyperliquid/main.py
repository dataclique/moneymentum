from typing import Any, Literal
import os
import sys
from pathlib import Path
from dataclasses import dataclass

# Add parent directory to path to allow imports when running from hyperliquid folder
parent_dir = Path(__file__).parent.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

from hyperliquid.settings import UserSettings
import ccxt # type: ignore[import]

DEBUG: bool = os.getenv("PROD", "").lower() != "true"
OrderSide = Literal["buy", "sell"]


@dataclass
class Position:
    """
    Represents a position from the exchange.
    """

    symbol: str
    percentage: float
    side: OrderSide

class Trader():
    public_key: str
    secret_key: str
    leverage: int

    def __init__(self, settings: UserSettings) -> None:
        self.public_key = settings.public_key
        self.secret_key = settings.secret_key

        # self.leverage = settings.trade.leverage TODO: Add leverage

        if DEBUG:
            print(f"Using wallet address: {self.public_key[:10]}...{self.public_key[-10:]}")

        self._initialize_exchange()

        print("Initialized Trader")

    def _initialize_exchange(self) -> None:
        """Initialize the ccxt exchange instance."""
        ccxt_config = {
            "walletAddress": self.public_key,
            "privateKey": self.secret_key,
            "enableRateLimit": True,
        }

        self.exchange = ccxt.hyperliquid(ccxt_config)
        if DEBUG:
            self.exchange.set_sandbox_mode(True)
            print("Running in DEBUG mode, using testnet URLs.")
            ccxt_config["urls"] = {
                "api": {
                    "public": "https://api.hyperliquid-testnet.xyz",
                    "private": "https://api.hyperliquid-testnet.xyz",
                }
            }

        self.exchange.verbose = False
        self.exchange.options["builderFee"] = False
        self.exchange.options["approvedBuilderFee"] = False
        self.exchange.options["defaultSlippage"] = 0.05  # 5% slippage as number
        self.exchange.load_markets()

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
        perp_symbols = [symbol for symbol, data in markets.items() if ":" in symbol and data.get("swap")]
        return sorted(perp_symbols)

    def open_positions(self, positions: list[Position], budget: float) -> list[dict[str, Any]]:
        """Open positions based on the given positions and budget."""
        if not positions:
            return []

        symbols = [pos.symbol for pos in positions]
        print(f"Fetching tickers for {len(symbols)} symbols...")

        tickers: dict[str, float] = {}
        for symbol in symbols:
            # TODO: we can do fetch_tickers(symbols) instead
            ticker = self.exchange.fetch_ticker(symbol)
            tickers[symbol] = float(ticker["last"])
            print(f"  {symbol}: {tickers[symbol]}")

        order_results: list[dict[str, Any]] = []
        print(f"\nCreating {len(positions)} orders...")
        for position in positions:
            current_price = tickers[position.symbol]
            amount = position.percentage * budget / current_price

            min_order_value = 10.0
            if position.percentage * budget < min_order_value:
                msg = (
                    f"Skipped {position.symbol}: allocation "
                    f"{position.percentage * budget:.2f} < ${min_order_value}"
                )
                print(msg)
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

            print(f"  {position.side} {amount} of {position.symbol} at {current_price}")

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
                print(error_msg)
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

    open_positions = [
        Position(symbol="BTC/USDC:USDC", percentage=0.5, side="buy"),
        Position(symbol="ETH/USDC:USDC", percentage=0.3, side="buy"),
        Position(symbol="SOL/USDC:USDC", percentage=0.2, side="buy"),
    ]

    trader.open_positions(open_positions, 50)
    print(f"Current balance: {trader.get_balance()} USDC")


if __name__ == "__main__":
    main()
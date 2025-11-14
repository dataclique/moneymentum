"""
Yang trading system - Core modules for momentum-based cryptocurrency trading.

This package contains the core components of the moneymentum trading system:

- chronos: Time series analysis engine using PySpark for calculating technical indicators
- strat: Trading strategy implementation combining momentum and mean reversion signals
- exe: Trade execution engine for Hyperliquid exchange via CCXT
- util: Shared utilities, configuration, and helper functions
- dataloader: Asynchronous data fetching from Hyperliquid exchange

The system is designed for automated trading of cryptocurrency perpetual futures,
with support for backtesting and live trading workflows.
"""

# Roadmap

> **Purpose**: Practical path from where we are today to the north star in [SPEC.md](./SPEC.md).

---

## Starting Point

**What we have:**

- **Portfolio rebalancer at `/`**: Set positions by weight, adjust cross-account leverage while maintaining proportions. Simple but already useful daily.
- **Historical data**: OHLCV and funding rates accumulated via collection scripts (more depth than Hyperliquid API provides directly).
- **Prototype at `/prototype`**: Design reference for target UI/UX. Like Figma but in code.

**What's missing:**

The rebalancer shows market exposure as `net = long notional - short notional`. This ignores correlations entirely—a portfolio that's "net neutral" in notional terms might still have massive BTC beta. Without beta, hedging is guesswork.

---

## Phase 1: Backend Foundation + Portfolio Beta

**Goal**: Users can see their portfolio's beta exposure, enabling proper hedging.

### 1.1 Backend Infrastructure

Set up Scala 2 + Spark project with Nix:

- Build configuration (sbt)
- Nix flake for reproducible dev environment
- Basic HTTP server (http4s) that can serve a health check

### 1.2 Data Ingestion

Fetch Hyperliquid market data in Scala:

- OHLCV candles for all perp markets
- Store in a format Spark can read (Parquet or similar)
- Scheduled refresh (cron or simple loop)

### 1.3 Beta Calculation

Compute rolling beta for each asset against BTC:

- Read historical returns from ingested data
- Calculate covariance / variance
- Expose via API endpoint

### 1.4 Portfolio Beta in Frontend

Wire portfolio beta into the rebalancer:

- Fetch betas from backend
- Compute portfolio-weighted beta
- Display alongside net notional

---

## Phase 2: Risk Analytics

**Goal**: Users can assess portfolio risk beyond just beta.

- Monte Carlo simulation of portfolio returns
- VaR/CVaR at configurable confidence levels
- Historical drawdown analysis
- Correlation matrix visualization

---

## Phase 3: Screener + Staged Trade Simulation

**Goal**: Users can find assets by factor characteristics and preview portfolio changes before executing.

- Screener: rank assets by beta, momentum, carry, volatility
- Staged trades: add/remove positions, see simulated impact on risk metrics
- Compare staged vs current portfolio

---

## Phase 4: Spot Trading

**Goal**: Unified perp + spot portfolio management.

- Hyperliquid spot integration
- Combined notional and weight calculations
- Single rebalance across both instrument types

---

## Future

These are directions we know matter but haven't designed:

- Options (Derive) for advanced risk management
- Tokenized equities (st0x) for TradFi factor exposure
- Yield products (Pendle)
- Multi-account support

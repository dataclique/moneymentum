# Roadmap

> **Purpose**: Practical path from where we are today to the north star in
> [SPEC.md](./SPEC.md).

---

## Starting Point

**What we have:**

- **Portfolio rebalancer at `/`**: Set positions by weight, adjust cross-account
  leverage while maintaining proportions. Simple but already useful daily.
- **Historical data**: OHLCV and funding rates accumulated via collection
  scripts (more depth than Hyperliquid API provides directly).
- **Prototype at `/prototype`**: Design reference for target UI/UX. Like Figma
  but in code.

**What's missing:**

The rebalancer shows market exposure as `net = long notional - short notional`.
This ignores correlations entirely—a portfolio that's "net neutral" in notional
terms might still have massive BTC beta. Without beta, hedging is guesswork.

---

## Phase 1: Backend Foundation + Portfolio Beta

> See SPEC.md: Technology Stack, Domain Architecture

**Goal**: Users can see their portfolio's beta exposure, enabling proper
hedging.

### 1.1 Backend Infrastructure

Set up Rust project with Nix:

- Cargo workspace structure
- Nix flake for reproducible dev environment
- Basic HTTP server (rocket) that can serve a health check

### 1.2 Data Ingestion

Fetch Hyperliquid market data:

- OHLCV candles for all perp markets
- Store in Parquet format for polars
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

## Phase 1.5: Wallet & Custody

> See SPEC.md: Custody & Execution, Security Model

**Goal**: Non-custodial programmable cross-chain wallet infrastructure—fund
creation, policy-enforced signing, and investor protection so that portfolio
managers can operate DeFi funds where depositors' capital is restricted to
approved operations (trading, venue transfers, fee collection, withdrawals) with
no possibility of misappropriation by either the platform or the PM.

> Phase 2 (Risk Analytics) does not strictly depend on wallet infrastructure,
> but Phases 3+ (execution, spot trading) require wallets for on-chain
> operations.

- ~~Wallet trait + crate architecture
  ([#97](https://github.com/data-cartel/moneymentum/issues/97))~~ —
  [PR #107](https://github.com/data-cartel/moneymentum/pull/107),
  [PR #108](https://github.com/data-cartel/moneymentum/pull/108)
- ~~Turnkey EVM signing
  ([#98](https://github.com/data-cartel/moneymentum/issues/98))~~ —
  [PR #109](https://github.com/data-cartel/moneymentum/pull/109)
- Turnkey Solana signing
  ([#99](https://github.com/data-cartel/moneymentum/issues/99))
- Turnkey Derive signing
  ([#100](https://github.com/data-cartel/moneymentum/issues/100))
- Turnkey bridge signing
  ([#101](https://github.com/data-cartel/moneymentum/issues/101))

---

## Phase 2: Risk Analytics

> See SPEC.md: Analytics Capabilities > Risk Engine

**Goal**: Users can assess portfolio risk beyond just beta.

- Monte Carlo simulation of portfolio returns
- VaR/CVaR at configurable confidence levels
- Historical drawdown analysis
- Correlation matrix visualization

---

## Phase 3: Screener + Staged Trade Simulation

> See SPEC.md: Core Workflow > Screen, Stage, Simulate

**Goal**: Users can find assets by factor characteristics and preview portfolio
changes before executing.

- Screener: rank assets by beta, momentum, carry, volatility
- Staged trades: add/remove positions, see simulated impact on risk metrics
- Compare staged vs current portfolio

---

## Phase 4: Spot Trading

> See SPEC.md: Domain Architecture > Spot Trading

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

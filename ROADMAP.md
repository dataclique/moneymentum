# Roadmap

> **Purpose**: Practical path from where we are today to the north star in
> [SPEC.md](./SPEC.md).

Each `##` section is an epic — a goal-oriented group of related issues. Epics
are ordered by priority (highest first).

---

## Portfolio beta in frontend

The backend already computes portfolio-weighted beta (`POST /beta` takes weights
and benchmark, returns a single beta value). The frontend doesn't use it yet —
the rebalancer still shows raw net notional, which ignores correlations and
makes hedging guesswork.

- [ ] Fetch portfolio beta from backend (`POST /beta`)
- [ ] Display alongside net notional in rebalancer

---

## Risk analytics

> See SPEC.md: Analytics Capabilities > Risk Engine

Portfolio risk assessment beyond beta.

- [ ] Monte Carlo simulation of portfolio returns
- [ ] VaR/CVaR at configurable confidence levels
- [ ] Historical drawdown analysis
- [ ] Correlation matrix visualization

---

## Screener and staged trade simulation

> See SPEC.md: Core Workflow > Screen, Stage, Simulate

Find assets by factor characteristics and preview portfolio changes before
executing.

- [ ] Screener: rank assets by beta, momentum, carry, volatility
- [ ] Staged trades: add/remove positions, see simulated impact on risk metrics
- [ ] Compare staged vs current portfolio

---

## Spot trading

> See SPEC.md: Domain Architecture > Spot Trading

Unified perp + spot portfolio management.

- [ ] Hyperliquid spot integration
- [ ] Combined notional and weight calculations
- [ ] Single rebalance across both instrument types

---

## Not epic

These are directions we know matter but haven't designed:

- Options (Derive) for advanced risk management
- Tokenized equities (st0x) for TradFi factor exposure
- Yield products (Pendle)
- Multi-account support

---

## Completed: Frontend rewrite in SolidJS

SolidJS compiles away the runtime, has cleaner reactivity, and shadcn-solid
provides the component library. Converted page by page — same logic, different
primitives.

- [x] Project setup: Vite + solid-js, TypeScript config, dev server
- [x] Routing: migrate from react-router to @solidjs/router
- [x] State & data fetching: migrate from @tanstack/react-query to
      @tanstack/solid-query
- [x] UI components: replace shadcn/ui with Kobalte + shadcn-solid equivalents
- [x] Layout & shared components: Header, WalletHeader, navigation
- [x] Portfolio page: PositionsPanel, TokenCard, portfolio table
- [x] Prototype page: RiskTab and all prototype-only components
- [x] Rebalancer integration: connect rebalancer logic to SolidJS signals/stores
- [x] Tests & CI: migrate Vitest tests to SolidJS testing utilities, verify CI
      passes

---

## Completed: Backend foundation and portfolio beta

Rust backend with Rocket, Polars, CQRS/ES on SQLite. Ingestion pipeline fetches
OHLCV and funding rates from Hyperliquid, stores as CSV. Beta calculation
computes rolling covariance/variance against BTC. Deployed to DigitalOcean via
NixOS + deploy-rs.

- [x] Cargo workspace + Nix flake + CI/CD
- [x] Rocket HTTP server with health check
- [x] CQRS event store + Apalis job queue (SQLite)
- [x] Hyperliquid OHLCV ingestion (15m, 1h, 1d candles)
- [x] Funding rate ingestion
- [x] Rolling beta calculation (`POST /beta`)
- [x] Candle API (`GET /candles/<timeframe>`)
- [x] Ingestion status API (`GET /ingestion/status`)

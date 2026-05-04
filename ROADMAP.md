# Roadmap

> **Purpose**: Practical path from where we are today to the north star in
> [SPEC.md](./SPEC.md).

Each `##` section is an epic — a goal-oriented group of related issues. Epics
are ordered by priority (highest first).

---

## Usable production deployment

Users need to reach the app before any portfolio feature matters. Deployment is
the next implementation priority.

- [ ] [Keep the app deployed and reachable](./user-stories/008-keep-app-deployed-and-reachable.md)
- [ ] [Verify deployed Hyperliquid long-short rebalancing](./user-stories/010-verify-deployed-hyperliquid-long-short-rebalancing.md)
- [ ] [Serve the app from a domain](./user-stories/009-serve-app-from-domain.md)

---

## Full Bitcoin beta accounting

The backend already computes portfolio-weighted beta (`POST /beta` takes weights
and benchmark, returns a single beta value). The frontend should show Bitcoin
beta for the active portfolio, then include read-only Bitcoin holdings so the
risk view reflects the user's actual exposure.

- [ ] [Show Bitcoin beta for the active portfolio](./user-stories/011-show-bitcoin-beta-for-active-portfolio.md)
- [ ] [Add read-only Bitcoin addresses](./user-stories/012-add-read-only-bitcoin-addresses.md)
- [ ] [Include read-only Bitcoin holdings in beta](./user-stories/013-include-read-only-bitcoin-holdings-in-beta.md)
- [ ] [Target ending Bitcoin beta while hedging](./user-stories/014-target-ending-bitcoin-beta-while-hedging.md)

---

## Portfolio identity and sharing

Read-only portfolios need stable identity. Solana public keys are the natural
identifier because the north star already assumes Solana deposits.

- [ ] [Authenticate portfolio ownership by Solana pubkey](./user-stories/015-authenticate-portfolio-ownership-by-solana-pubkey.md)
- [ ] [View portfolios by public key URL](./user-stories/016-view-portfolios-by-public-key-url.md)
- [ ] [Hide portfolio details for a fee](./user-stories/017-hide-portfolio-details-for-fee.md)

---

## Crash protection and simulation

Users who are long-term bullish Bitcoin still need protection against short- and
mid-term crashes. Start with manually entered protective puts and simple
historical crash simulations, then add stressed correlations and rolling.

- [ ] [Enter protective put positions](./user-stories/019-enter-protective-put-positions.md)
- [ ] [Simulate historical Bitcoin crashes](./user-stories/020-simulate-historical-bitcoin-crashes.md)
- [ ] [Simulate stressed crash correlations](./user-stories/021-simulate-stressed-crash-correlations.md)
- [ ] [Roll protective puts before final month](./user-stories/022-roll-protective-puts-before-final-month.md)

---

## Risk analytics

> See SPEC.md: Analytics Capabilities > Risk Engine

Portfolio risk assessment beyond beta and crash-specific simulations.

- [ ] Monte Carlo simulation of portfolio returns
- [ ] VaR/CVaR at configurable confidence levels
- [ ] Historical drawdown analysis
- [ ] Correlation matrix visualization

---

## Spot trading

> See SPEC.md: Domain Architecture > Spot Trading

Unified perp + spot portfolio management.

- [ ] Hyperliquid spot integration
- [ ] Combined notional and weight calculations
- [ ] Single rebalance across both instrument types
- [ ] [Add read-only wallets on other chains](./user-stories/018-add-read-only-wallets-on-other-chains.md)

---

## Not epic

These are directions we know matter but haven't designed:

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

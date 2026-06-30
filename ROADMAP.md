# Roadmap

> **Purpose**: Practical path from where we are today to the north star in
> [SPEC](./SPEC.md).

Each `##` section is a theme -- a goal-oriented group of related stories. Themes
are ordered by priority (highest first).

Stories live as GitHub issues labeled
[`user-story`](https://github.com/data-cartel/moneymentum/issues?q=label%3Auser-story);
each issue holds the story's acceptance criteria. Engineering work (refactors,
migrations, internal foundations) shares the same hex-indexed sequence when a
written contract is warranted, otherwise it is a standalone GitHub issue -- see
[contributions.md](./contributions.md) for the split.

Hex story IDs (`0x001`, `0x018`, etc.) reflect creation order, not
implementation priority. Priority is defined by this roadmap's theme order and
the order within each theme.

---

## Dev: event-sourced persistence foundation

Give the toolkit durable, auditable state via
[event-sorcery](https://github.com/ST0X-Technology/event-sorcery): portfolios
(target streams that enable auto-rebalancing), the ingestion lifecycle, and the
tradable market universe. Each domain is an event-sourced aggregate so history
is a first-class artifact for later performance attribution and prediction, and
the design stays forward-compatible with multiple instruments and venues.
Design: [adrs/0001](./adrs/0001-event-sorcery-persistence-foundation.md).

- [ ] Adopt the event-sorcery event-store stack (sqlx 0.9, apalis 1.0-rc) --
      [#363](https://github.com/data-cartel/moneymentum/issues/363) /
      [#361](https://github.com/data-cartel/moneymentum/pull/361)
- [ ] Event-source portfolios, ingestion runs, and the market universe --
      [#364](https://github.com/data-cartel/moneymentum/issues/364) /
      [#362](https://github.com/data-cartel/moneymentum/pull/362)
- [ ] Serve per-market max leverage limits from the catalog --
      [#379](https://github.com/dataclique/moneymentum/issues/379) /
      [#380](https://github.com/dataclique/moneymentum/pull/380)

---

## Dev: finish the Python -> Rust analytics migration

Port the deleted Python quant analytics to Rust as the factor and risk engine
that powers the "Screener and staged simulation" and "Risk analytics" themes
below. The autonomous trader's auto-pick/execute loop is out of scope --
execution stays in the frontend. Delivered as a stack of small PRs; the
user-facing endpoints tick their story items under those themes. This is an
engineering track that runs in parallel to the product themes below, not ahead
of them.

- [x] Point user stories at the factors module --
      [#304](https://github.com/dataclique/moneymentum/issues/304) /
      [#250](https://github.com/dataclique/moneymentum/pull/250)
- [x] Consolidate beta into a factors module --
      [#249](https://github.com/dataclique/moneymentum/issues/249) /
      [#252](https://github.com/dataclique/moneymentum/pull/252)
- [x] Add TimeframeConfig (lookback + annualization) --
      [#251](https://github.com/dataclique/moneymentum/issues/251) /
      [#254](https://github.com/dataclique/moneymentum/pull/254)
- [x] Split the factor engine into returns/beta/scores submodules --
      [#257](https://github.com/dataclique/moneymentum/issues/257) /
      [#258](https://github.com/dataclique/moneymentum/pull/258)
- [x] Factor: returns shared primitive --
      [`src/factors/returns.rs`](./src/factors/returns.rs)
- [x] Factor: cum_return --
      [#253](https://github.com/dataclique/moneymentum/issues/253) /
      [#254](https://github.com/dataclique/moneymentum/pull/254)
- [x] Factor: volatility --
      [#251](https://github.com/dataclique/moneymentum/issues/251) /
      [#254](https://github.com/dataclique/moneymentum/pull/254)
- [x] Factor: SMA --
      [#255](https://github.com/dataclique/moneymentum/issues/255) /
      [#256](https://github.com/dataclique/moneymentum/pull/256)
- [x] Factor: mean return --
      [#255](https://github.com/dataclique/moneymentum/issues/255) /
      [#256](https://github.com/dataclique/moneymentum/pull/256)
- [x] Factor: price z-score --
      [#255](https://github.com/dataclique/moneymentum/issues/255) /
      [#256](https://github.com/dataclique/moneymentum/pull/256)
- [x] Factor: Sharpe --
      [#259](https://github.com/dataclique/moneymentum/issues/259) /
      [#260](https://github.com/dataclique/moneymentum/pull/260)
- [x] Factor: Sortino (adds MAR -- Minimum Acceptable Return -- to
      TimeframeConfig) --
      [#261](https://github.com/dataclique/moneymentum/issues/261) /
      [#262](https://github.com/dataclique/moneymentum/pull/262)
- [x] Factor: autocorrelation --
      [#263](https://github.com/dataclique/moneymentum/issues/263) /
      [#264](https://github.com/dataclique/moneymentum/pull/264)
- [x] Factor: information discreteness --
      [#265](https://github.com/dataclique/moneymentum/issues/265) /
      [#266](https://github.com/dataclique/moneymentum/pull/266)
- [x] Factor: carry (signed funding) --
      [#267](https://github.com/dataclique/moneymentum/issues/267) /
      [#268](https://github.com/dataclique/moneymentum/pull/268)
- [x] Factor: beta (per-asset, to benchmark) --
      [#269](https://github.com/dataclique/moneymentum/issues/269) /
      [#270](https://github.com/dataclique/moneymentum/pull/270)
- [x] Factor: 24h volume (screener tie-break) --
      [#271](https://github.com/dataclique/moneymentum/issues/271) /
      [#272](https://github.com/dataclique/moneymentum/pull/272)
- [x] Markets metadata + persisted disable flag --
      [#275](https://github.com/dataclique/moneymentum/issues/275) /
      [#276](https://github.com/dataclique/moneymentum/pull/276)
- [x] Tradable filter wired into ingestion --
      [#277](https://github.com/dataclique/moneymentum/issues/277) /
      [#278](https://github.com/dataclique/moneymentum/pull/278)
- [x] Move user stories from repo files to GitHub issues --
      [#341](https://github.com/dataclique/moneymentum/issues/341) /
      [#342](https://github.com/dataclique/moneymentum/pull/342)
- [x] Risk metrics: historical VaR/CVaR --
      [#343](https://github.com/dataclique/moneymentum/issues/343) /
      [#344](https://github.com/dataclique/moneymentum/pull/344)
- [x] Risk metrics: historical max drawdown --
      [#345](https://github.com/dataclique/moneymentum/issues/345) /
      [#346](https://github.com/dataclique/moneymentum/pull/346)
- [x] Risk metrics: Ledoit-Wolf shrunk correlation matrix --
      [#347](https://github.com/dataclique/moneymentum/issues/347) /
      [#348](https://github.com/dataclique/moneymentum/pull/348)
- [x] Risk metrics: effective number of bets (Meucci + stressed + 1/HHI) --
      [#349](https://github.com/dataclique/moneymentum/issues/349) /
      [#350](https://github.com/dataclique/moneymentum/pull/350)

---

## Usable production deployment

Users need to reach the app before any portfolio feature matters. Deployment is
the next user-facing priority; it runs in parallel to the Dev track above.

- [ ] [Keep The App Deployed And Reachable](https://github.com/data-cartel/moneymentum/issues/312)
- [ ] [Verify Deployed Hyperliquid Long-Short Rebalancing](https://github.com/data-cartel/moneymentum/issues/314)
- [ ] [Serve The App From A Domain](https://github.com/data-cartel/moneymentum/issues/313)

---

## Full Bitcoin beta accounting

Display portfolio-weighted Bitcoin beta for the active portfolio and surface
read-only Bitcoin holdings so the risk view reflects the user's actual exposure.
See [SPEC.md](./SPEC.md) for the beta methodology and the `POST /beta` contract.

- [x] [Show Bitcoin Beta For The Active Portfolio](https://github.com/data-cartel/moneymentum/issues/315)
- [x] [Add Read-Only Bitcoin Addresses](https://github.com/data-cartel/moneymentum/issues/316)
- [ ] [Include Read-Only Bitcoin Holdings In Beta](https://github.com/data-cartel/moneymentum/issues/317)
- [ ] [Target Ending Bitcoin Beta While Hedging](https://github.com/data-cartel/moneymentum/issues/318)

---

## Portfolio identity and sharing

Read-only portfolios need stable identity. Solana public keys are the natural
identifier because the north star already assumes Solana deposits.

- [ ] [Authenticate Portfolio Ownership By Solana Pubkey](https://github.com/data-cartel/moneymentum/issues/319)
- [ ] [View Portfolios By Public Key URL](https://github.com/data-cartel/moneymentum/issues/320)
- [ ] [Hide Portfolio Details For A Fee](https://github.com/data-cartel/moneymentum/issues/321)

---

## Vault

Non-custodial managed vault on Solana for users who prefer strategy allocation
over hands-on rebalancing. Anchor program with two-phase withdrawal and a
share-based accounting model.

- [ ] [Deposit Into Vault](https://github.com/data-cartel/moneymentum/issues/327)
- [ ] [Withdraw From Vault](https://github.com/data-cartel/moneymentum/issues/328)

---

## Crash protection and simulation

Users who are long-term bullish Bitcoin still need protection against short- and
mid-term crashes. Start with manually entered protective puts and simple
historical crash simulations, then add stressed correlations and rolling.

- [ ] [Enter Protective Put Positions](https://github.com/data-cartel/moneymentum/issues/323)
- [ ] [Use Derive Options For Protective Puts](https://github.com/data-cartel/moneymentum/issues/329)
- [ ] [Simulate Historical Bitcoin Crashes](https://github.com/data-cartel/moneymentum/issues/324)
- [ ] [Simulate Stressed Crash Correlations](https://github.com/data-cartel/moneymentum/issues/325)
- [ ] [Roll Protective Puts Before Final Month](https://github.com/data-cartel/moneymentum/issues/326)

---

## Screener and staged simulation

> See SPEC.md: Core Workflow > Screen, Stage, Simulate

Find assets by factor characteristics, stage portfolio changes, and simulate the
result before sending trades.

- [ ] [Compare Target vs Current Portfolio](https://github.com/data-cartel/moneymentum/issues/330)
      -- backend compare API shipped
      ([#279](https://github.com/data-cartel/moneymentum/issues/279) /
      [#280](https://github.com/data-cartel/moneymentum/pull/280)); frontend
      portfolio surface pending
- [ ] [Screen Perps By Factor](https://github.com/data-cartel/moneymentum/issues/332)
      -- backend rank API shipped
      ([#273](https://github.com/data-cartel/moneymentum/issues/273) /
      [#274](https://github.com/data-cartel/moneymentum/pull/274)); frontend
      filter integration pending
- [ ] [Simulate Staged Portfolio Metrics](https://github.com/data-cartel/moneymentum/issues/333)
      -- backend simulate API shipped
      ([#281](https://github.com/data-cartel/moneymentum/issues/281) /
      [#282](https://github.com/data-cartel/moneymentum/pull/282)); frontend
      staging view pending

---

## Risk analytics

> See SPEC.md: Analytics Capabilities > Risk Engine

Portfolio risk assessment beyond beta and crash-specific simulations.

- [ ] [Show Risk Analytics For Active Portfolio](https://github.com/data-cartel/moneymentum/issues/331)
      -- measurement contract shipped
      ([#283](https://github.com/data-cartel/moneymentum/issues/283) /
      [#284](https://github.com/data-cartel/moneymentum/pull/284)); historical
      VaR/CVaR shipped
      ([#343](https://github.com/data-cartel/moneymentum/issues/343) /
      [#344](https://github.com/data-cartel/moneymentum/pull/344)); historical
      max drawdown shipped
      ([#345](https://github.com/data-cartel/moneymentum/issues/345) /
      [#346](https://github.com/data-cartel/moneymentum/pull/346)); shrunk
      correlation matrix shipped
      ([#347](https://github.com/data-cartel/moneymentum/issues/347) /
      [#348](https://github.com/data-cartel/moneymentum/pull/348)); effective
      number of bets shipped
      ([#349](https://github.com/data-cartel/moneymentum/issues/349) /
      [#350](https://github.com/data-cartel/moneymentum/pull/350)); Monte Carlo
      metrics and the frontend pending

---

## Spot trading

> See SPEC.md: Domain Architecture > Spot Trading

Unified perp + spot portfolio management.

- [ ] [Trade Hyperliquid Spot Positions](https://github.com/data-cartel/moneymentum/issues/334)
- [ ] [Add Read-Only Wallets On Other Chains](https://github.com/data-cartel/moneymentum/issues/322)

---

## Backlog

These are directions we know matter but haven't designed:

- Tokenized equities (st0x) for TradFi factor exposure
- Yield products (Pendle)
- Multi-account support

---

## Completed: Frontend rewrite in SolidJS

SolidJS compiles away the runtime, has cleaner reactivity, and shadcn-solid
provides the component library. Converted page by page -- same logic, different
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

Rust backend with Rocket, Polars, and SQLite-backed ingestion runs/job queue.
Ingestion pipeline fetches OHLCV and funding rates from Hyperliquid, stores as
CSV. Beta calculation computes rolling covariance/variance against BTC. Deployed
to DigitalOcean via NixOS + deploy-rs.

- [x] Cargo workspace + Nix flake + CI/CD
- [x] Rocket HTTP server with health check
- [x] Ingestion run ledger + Apalis job queue (SQLite)
- [x] Hyperliquid OHLCV ingestion (15m, 1h, 1d candles)
- [x] Funding rate ingestion
- [x] Rolling beta calculation (`POST /beta`)
- [x] Candle API (`GET /candles/<timeframe>`)
- [x] Ingestion status API (`GET /ingestion/status`)

---

## Completed: GitButler CLI for stacked PRs

- [x] Package the GitButler CLI via Nix --
      [#243](https://github.com/dataclique/moneymentum/issues/243) /
      [#238](https://github.com/dataclique/moneymentum/pull/238)
- [x] Add a GitButler skill for coding agents --
      [#244](https://github.com/dataclique/moneymentum/issues/244) /
      [#240](https://github.com/dataclique/moneymentum/pull/240)

## Completed: Finish Python/Spark removal

- [x] Remove dead Python linter tooling --
      [#245](https://github.com/dataclique/moneymentum/issues/245) /
      [#241](https://github.com/dataclique/moneymentum/pull/241)
- [x] Strip unused JVM/Spark deps from the dev shell --
      [#246](https://github.com/dataclique/moneymentum/issues/246) /
      [#242](https://github.com/dataclique/moneymentum/pull/242)

## Completed: Per-PR issue and roadmap tracking

- [x] Document and automate the issue-and-roadmap-per-PR rule --
      [#247](https://github.com/dataclique/moneymentum/issues/247) /
      [#248](https://github.com/dataclique/moneymentum/pull/248)

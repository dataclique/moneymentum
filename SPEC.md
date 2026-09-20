# Moneymentum specification

Moneymentum is a discretionary portfolio research and execution tool. It
combines historical portfolio performance, factor-based construction, risk
analysis, and staged execution. [ROADMAP.md](./ROADMAP.md) orders delivery;
[GitHub issues](https://github.com/dataclique/moneymentum/issues) hold
requirements and acceptance criteria.

Portfolio construction starts with desired exposures and outcomes. The system
selects cost-effective options, contracts, or combinations that can express
those outcomes; users review and decide whether to stage or execute them.
Examples include reducing total BTC sensitivity, constraining downside while
retaining upside, or gaining momentum without adding market beta. These examples
do not equate beta with options delta and do not guarantee that a hedge is
cheap.

## Domain model

Targets express asset or factor proportions and explicit leverage. Total target
exposure is NAV multiplied by leverage. Weights drift as prices, funding, cash
flows, and positions change.

The supported analytical factors are benchmark sensitivity (beta), momentum,
carry, volatility, and Sharpe. Beta measures return sensitivity to a benchmark;
option delta measures price sensitivity to an underlying. Use precise financial
terms and define them where first introduced.

Risk analysis includes VaR, CVaR, correlations, effective bets, and historical
stress scenarios. Performance reporting separates cash flows from PnL and labels
observed history, backtests, and simulations distinctly.

## User workflow

The workflow is:

`Monitor -> Screen -> Stage -> Simulate -> Execute -> Repeat`

Monitor shows current portfolio and risk. Screen ranks and filters candidates.
Stage compares proposed changes with current positions and shows trades.
Simulate evaluates the staged portfolio. Execute occurs only after the user's
decision. Repeat observes the resulting portfolio and its subsequent drift.

Portfolio construction targets exposures and outcomes rather than hard-coded
symbols. A new venue adapter must not require changes to portfolio logic.

## Portfolio and venue boundaries

The backend is divided by domain capability:

| Domain       | Capability                                             |
| ------------ | ------------------------------------------------------ |
| `portfolio`  | weights, current positions, NAV, and target exposures  |
| `analytics`  | factor, performance, risk, and simulation calculations |
| `chain`      | Solana, EVM, and mock chain access                     |
| `spot`       | Hyperliquid, Jupiter, and mock spot venues             |
| `perps`      | Hyperliquid and mock perpetual venues                  |
| `options`    | Derive and mock options venues                         |
| `bridging`   | deBridge and mock transfers                            |
| `wallet`     | Turnkey and mock signing                               |
| `vault`      | Anchor and mock vault clients                          |
| `rebalancer` | trade orchestration across venues and chains           |
| `api`        | the HTTP entrypoint and endpoint handlers              |

External adapters implement `Chain`, `Analytics`, `SpotVenue`, `PerpsVenue`,
`OptionsVenue`, `Bridge`, `Wallet`, or `VaultClient`, with common domain types.
Adapters are feature-gated and implement those contracts without leaking venue
details into portfolio logic.

The backend is Rust. The frontend is TypeScript with SolidJS. The HTTP API uses
axum. Analytics use polars and linfa. SQLite stores ingestion runs and supports
an Apalis queue; Postgres is the growth target. Parquet stores historical
analytics. TypeScript bindings are generated with ts-rs.

## Data and analytics endpoints

`GET /factors/<timeframe>` returns per-asset rolling beta and factor columns
from ingested OHLCV and funding data. The screener ranks and filters those
results.

`POST /beta` accepts position weights and a benchmark symbol. It returns
weighted per-asset rolling betas calculated from daily log returns and candles.
Endpoint details live beside the handler contract.

Historical performance endpoints must show how cash flows affect account value
and must distinguish realized and unrealized PnL where the source data permits.
Backtest and simulation results are labelled as hypothetical.

## Execution and custody

Turnkey enforces signing policy and uses enclave wallets. The backend never
handles raw private keys. Contract allowlists, calldata validation, and deny
policies constrain actions. Trade-only credentials are separate from credentials
with withdrawal privileges.

The target custody flow is:

| Route                       | Path                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Deposits and withdrawals    | Anchor Solana vault with share-token accounting and fees                                                   |
| Spot route                  | Vault -> Turnkey SOL wallet -> HumidiFi spot                                                               |
| Solana-to-Hyperliquid route | Turnkey SOL wallet -> deBridge USDC on Solana -> Turnkey EVM wallet on HyperEVM -> HyperCore spot or perps |
| HyperEVM options route      | HyperEVM native deposit -> Derive options                                                                  |
| Withdrawal return           | USDC returns through the supported bridge and vault withdrawal flow                                        |

The backend aggregates venue NAV and posts signed attestations to the vault. The
vault accounts for investor shares, deposits, withdrawals, and fees. Management
fees are an annual percentage of AUM deducted on withdrawal. Performance fees
apply to new profits above a high-water mark. Platform fees are a percentage of
the portfolio manager's collected fees, not investor capital. Personal use has
zero management and performance fees.

## Contracts and integrations

The vault contract is Anchor based. Solana integrations use `solana-sdk` and
`anchor-client`. EVM integrations use alloy. Venue and routing integrations
include `hyperliquid-rs`, Cockpit, and `jupiter-swap-api-client`; SQL access
uses sqlx.

Data adapters normalize source data for analytics. Venue adapters expose
execution and observation contracts. Chain, bridge, wallet, and vault clients
keep their external protocols behind their domain traits. Mock implementations
support contract and workflow tests.

## Frontend

The dashboard is a monitoring and control surface. It is keyboard-first,
mouse-friendly, and supports vim and Bloomberg-style shortcuts. Every action is
also clickable.

Staged changes immediately show risk, exposure, and trade feedback. If
projections fail or become stale, the interface marks them unavailable and
requires explicit acknowledgement of degraded metrics before submission, as
defined in
[the staged simulation contract](https://github.com/dataclique/moneymentum/issues/333).

## Future directions

These areas remain exploration, without a detailed design or delivery
commitment:

| Area                   | Intended use                            |
| ---------------------- | --------------------------------------- |
| Tokenized equities     | SPY and TLT exposure for factor hedging |
| Fixed income and yield | Yield-bearing positions and staking     |
| Multi-account          | Isolated risk on shared infrastructure  |

## Safety boundaries

Execution requires an explicit user decision after staging and reviewing the
simulation or acknowledging its unavailable state. Signing policy, allowlist,
calldata, credential, and venue-contract checks remain mandatory. Withdrawal
authority stays separate from trade execution authority.

The specification describes target contracts and behavior. Delivery order,
progress, incidents, and unresolved work belong in the roadmap and linked GitHub
issues.

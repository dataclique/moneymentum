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

### NAV attestation boundary

The backend aggregates venue NAV and posts signed attestations to the vault. A
signature authenticates the reporter, not the correctness of its valuation. The
vault must reject an attestation before changing balances unless:

- Its signer is authorized by the vault's on-chain authority. The signed payload
  binds the deployment, vault, valuation currency and scale, NAV, valuation
  timestamp, sequence number, and signer epoch.
- The valuation timestamp does not move backwards or exceed the on-chain clock,
  and its age is within an explicitly configured freshness limit. Missing or
  stale venue observations cannot be presented as a fresh complete valuation.
- Its sequence is strictly greater than the vault's last accepted sequence.
  Accepting a valuation and advancing replay-protection state are atomic; a
  consumed signature cannot install the valuation again.
- Its signer epoch is current. Only the on-chain authority can rotate or revoke
  signers; those changes invalidate earlier epochs without resetting sequence
  history. Revoked signatures and cached valuations from a revoked epoch cannot
  authorize deposits, withdrawal settlement, or fee settlement.

Vault state must retain the authority, authorized signer and epoch, freshness
limit, and last accepted valuation with its timestamp and sequence. Each
NAV-dependent instruction rechecks freshness and reconciles intervening cash
flows; accepting an attestation once does not make it valid indefinitely or
allow deposits and withdrawals to be counted twice. Invalid inputs leave shares,
fees, and withdrawal state unchanged. Contract tests must cover unauthorized and
revoked signers, wrong deployment or vault, replay, out-of-order and future
valuations, staleness at use time, and cash flows after a valuation.

### Vault accounting contract

The vault accounts for investor shares, deposits, withdrawals, and fees.
Management fees are an annual percentage of AUM, settled on withdrawal;
performance fees apply only to new profits above a per-investor high-water mark.
Platform fees come from the manager's collected fees, not an additional charge
on investor capital. Zero management and performance rates for personal use
therefore also produce zero platform fees from those charges.

The authoritative delivery contracts are
[deposits](https://github.com/dataclique/moneymentum/issues/327),
[withdrawals](https://github.com/dataclique/moneymentum/issues/328), and
[fee transparency](https://github.com/dataclique/moneymentum/issues/336). Before
vault money movement ships, they must agree on one versioned accounting contract
with matching on-chain and client test vectors for:

- **Valuation and deposits:** the NAV snapshot and cash-flow cutoff,
  liabilities, pending withdrawals, share supply, initial share price, and
  conversion rounding. Deposits mint against pre-deposit value and must not
  count contributed capital as profit or charge fees for time before that
  capital arrived.
- **Management fees:** the annual-rate time basis, equity basis, accrual
  interval, and collection mechanism. Elapsed-time accrual must be settled
  before performance fees and payout; deposits and partial withdrawals must not
  erase accrued fees, charge the same interval twice, or reset another
  investor's accrual history.
- **Performance fees:** the per-investor profit basis after management fees,
  settlement timing, and high-water-mark changes after deposits, losses,
  recoveries, and partial or full withdrawals. Previously charged gains cannot
  be charged again, and cash flows cannot create fictitious gains or erase loss
  recovery requirements.
- **Withdrawals:** `request_withdraw` records intent and an unlock time;
  `execute_withdraw` settles only after the redeem period, calculates fees and
  net USDC from the settlement valuation, burns the corresponding shares, and
  consumes that request atomically. Failed settlement changes none of these;
  replay cannot burn or pay twice. Partial withdrawals must preserve the
  remaining investor's shares, accrued-fee allocation, and high-water-mark
  basis.
- **Conservation:** explicit integer units, checked arithmetic, rounding and
  dust ownership; investor payouts, remaining claims, and manager/platform fees
  must reconcile to vault assets. Platform and manager allocations sum to
  collected fees, with rates and accrual state read from the same on-chain
  source by clients.

These are release gates, not a finalized fee algorithm. In particular,
[fee math #127](https://github.com/dataclique/moneymentum/issues/127) describes
share dilution while
[withdrawals #328](https://github.com/dataclique/moneymentum/issues/328)
describes per-user settlement using a vault accrual timestamp. That accounting
choice, valuation timing, day-count convention, rounding, and high-water-mark
adjustment rules require an explicit design decision and shared test vectors
before implementation. Neither a client nor the vault may supply implicit
financial-policy defaults to fill those gaps.

## Contracts and integrations

The vault contract is Anchor based. Solana integrations use `solana-sdk` and
`anchor-client`. EVM integrations use alloy. Venue and routing integrations
include `hyperliquid-rs`, Cockpit, and `jupiter-swap-api-client`; SQL access
uses sqlx.

Data adapters normalize source data for analytics. Venue adapters expose
execution and observation contracts. Chain, bridge, wallet, and vault clients
keep their external protocols behind their domain traits. Mock implementations
support contract and workflow tests.

### Execution outcomes and recovery

Each execution retains an account-, venue-, and plan-scoped identity with its
per-order identities, submitted intent, acknowledgements, fills, and latest
observations. Submission acknowledgement is not completion:

- **Confirmed:** related orders are terminal and fresh venue positions reconcile
  with the intended changes, using explicit venue quantity and rounding rules.
- **Partial:** some changes are confirmed, but the remaining intended changes
  are incomplete. Per-order rejection, cancellation, and unresolved status
  remain visible; confirmed fills are never discarded.
- **Rejected:** the venue proves that the action was rejected without execution.
- **Ambiguous:** acceptance, terminal status, or resulting positions cannot yet
  be established. An accepted order without reconciled venue state stays
  ambiguous, even after a timeout. A partially completed plan can contain
  ambiguous orders.

Reloads, reconnects, repeated clicks, and account switches resume reconciliation
of the same execution; they do not submit another copy or clear pending intent.
Stale observations cannot advance an execution to confirmed. Recovery first
queries the recorded order identities and reconciles fills and current
positions. Dependent actions remain blocked while their prerequisites are
partial, rejected, or ambiguous; resuming the plan requires a newly reviewed
residual intent and an explicit user decision.

The retry guarantee is **no duplicate economic action**, not a promise of
exactly-once transport. A transport retry may reuse the same order identity only
when the adapter's documented and tested venue contract guarantees deduplication
for that request and retry interval. Otherwise an ambiguous submission is
observation-only: no automatic resubmission, including after the deduplication
window expires. Once non-execution or the settled residual is proven, any new
order requires a fresh account/position check and user-approved residual plan;
confirmed fills are never replayed. If the venue cannot resolve uncertainty,
show an explicit blocker rather than infer failure or success.

The completion and recovery requirements remain tracked in
[#92](https://github.com/dataclique/moneymentum/issues/92) and
[#159](https://github.com/dataclique/moneymentum/issues/159).

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

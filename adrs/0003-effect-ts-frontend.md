# ADR 0003: adopt Effect (effect-ts) for frontend effectful code

- Status: Accepted -- implementing in the PR #158 worktree per the maintainer;
  reviewed via the resulting PR
- Date: 2026-06-28
- Tracking issue: TBD (to be filed)
- Relates to: PR #158, ADR 0002 (backend venue crates)

## Context

The SolidJS frontend concentrates its async/effectful logic in a few places: the
services layer (`hyperliquid-client.ts` -- HTTP + websocket order batches,
market/ticker/position loading, `rebalancePositions`), the hooks (`useTrading`,
`useWallet`, `useApi`), and the data layer of the `DeriveOptions` page. Error
handling is ad hoc (try/catch, and -- per DOC.MD's "Observed Limitations" -- at
least one path where an action with no usable ticker is **skipped silently**,
producing no order and no result).

The maintainer wants the [Effect](https://effect.website) library used on the
frontend.

**This is distinct from SolidJS `createEffect`.** The repo's "Avoid
createEffect" rule (frontend/CLAUDE.md) targets overuse of SolidJS's reactive
effect primitive and is unrelated to and unaffected by this decision.

## Decision

Adopt effect-ts for the frontend's **effectful/async surfaces**:

1. **Model async I/O as `Effect` values with typed error channels** instead of
   throwing / bare try-catch: HTTP requests, websocket order batches, order
   submission, market/ticker/position loading.
2. **Services expose Effect-returning APIs.** SolidJS components run them at the
   edge (e.g. `Effect.runPromise` inside `createResource` or event handlers).
   SolidJS reactivity (signals/resources/memos) remains the UI layer; Effect
   owns the effectful core. A thin bridge converts Effect outcomes into the
   resource/signal shapes the components already consume.
3. **Replace silent failure modes with explicit typed errors** surfaced to the
   UI -- starting with the "skipped silently" no-ticker case.
4. **Scope:** services, the API/websocket layer, and data-fetching + error
   handling in the refactored `DeriveOptions` page. NOT a wholesale rewrite of
   pure presentational components.

## Consequences

- New dependency (`effect`); a learning surface for contributors.
- Typed, composable errors and explicit failure handling replace silent skips.
- A bridge layer between Effect and SolidJS reactivity must be maintained.
- `bun.nix` must be regenerated (pinned bun2nix) for the new dependency.

## Alternatives considered

- **`@tanstack/solid-query` only** (the current data-fetching convention):
  complements caching but does not provide the typed effect/error system the
  maintainer asked for. Keep solid-query for query caching where it fits, with
  Effect underneath for the effectful logic.
- **Status quo (async/await + try/catch):** rejected per the maintainer; it is
  the source of the silent-failure limitations noted in DOC.MD.

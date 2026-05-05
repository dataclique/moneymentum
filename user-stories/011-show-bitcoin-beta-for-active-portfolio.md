---
status: planned
theme: full-bitcoin-beta-accounting
---

# Show Bitcoin Beta For The Active Portfolio

As a user, I want to see my portfolio beta to Bitcoin so that I can understand
whether my long-short book is actually hedged.

## Acceptance Criteria

"Bitcoin beta" in this story refers to a fixed methodology so the displayed
number is reproducible across the UI, backend, and tests:

- Benchmark: BTC perpetual on Hyperliquid (the same symbol the backend ingests
  for the rolling-beta calculation).
- Return interval: daily log returns.
- Lookback window: 252 trading days (one year).
- Weighting: active position weights, normalized to sum to one in absolute
  value across the included positions.
- Missing/stale prices: assets without enough history in the lookback window
  are excluded from the weighted sum and surfaced in the loading/failure UI
  rather than silently substituted.

- [ ] The portfolio page requests Bitcoin beta (as defined above) for the
      active target portfolio.
- [ ] The UI shows beta beside the existing exposure summary, with the
      benchmark, interval, and lookback labelled or available on hover.
- [ ] Loading and failure states are visible for both the benchmark fetch and
      the beta computation.
- [ ] The beta calculation uses active position weights, not raw net notional.
- [ ] Rebalancer edits trigger recalculation so the displayed beta reflects
      the current set of positions and weights.

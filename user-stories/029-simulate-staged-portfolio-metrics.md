---
status: planned
theme: screener-and-staged-simulation
---

# Simulate Staged Portfolio Metrics

As a user, I want staged trades to show their projected impact on portfolio
metrics so that I can decide whether the rebalance is worth executing before I
send any trades.

## Acceptance Criteria

- [ ] Staging a position change projects the post-change portfolio weights.
- [ ] Staging projects the post-change beta to Bitcoin.
- [ ] Staging projects the post-change risk metrics where they are available.
- [ ] The view shows current and staged side-by-side for direct comparison.
- [ ] The specific trades needed to move from current to staged are visible.
- [ ] Clearing staged changes restores the current view.
- [ ] A simulation failure does not block submitting the rebalance.

## Related Work

- Issue [#76](https://github.com/data-cartel/moneymentum/issues/76) — staged
  simulation scope

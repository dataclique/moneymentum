---
status: planned
theme: screener-and-staged-simulation
---

# Compare Target vs Current Portfolio

As a user, I want to clearly see how my current allocation has drifted from my
target so that I can decide whether to rebalance and understand what will happen
when I do.

## Acceptance Criteria

- [ ] The portfolio surface labels target and current allocations distinctly.
- [ ] Each position row shows target weight, current weight, and the delta.
- [ ] Positions whose delta is below the minimum tradable change are visibly
      marked as such.
- [ ] When the user opens the app after a price move, the drift is visible
      without having to stage any trades.
- [ ] Clicking Rebalance reflects the previewed deltas in the staged trades.
- [ ] Loading and failure states for current portfolio data are visible.

## Related Work

- Issue [#52](https://github.com/data-cartel/moneymentum/issues/52) — original
  problem statement and proposed solution

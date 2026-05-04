---
status: planned
theme: spot-trading
---

# Trade Hyperliquid Spot Positions

As a user, I want to manage spot positions on Hyperliquid alongside perps so
that my full Hyperliquid book is rebalanced together rather than as two separate
workflows.

## Acceptance Criteria

- [ ] Spot symbols appear in the screener alongside perps.
- [ ] The portfolio view distinguishes spot from perp positions.
- [ ] Combined notional and weight calculations include both instrument types.
- [ ] A single rebalance action stages and executes trades across spot and perp.
- [ ] Venue rules that differ between spot and perp (minimums, no leverage on
      spot) are respected per instrument.

## Related Work

- Issue [#77](https://github.com/data-cartel/moneymentum/issues/77) — spot
  integration scope

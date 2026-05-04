---
status: planned
theme: risk-analytics
---

# Show Risk Analytics For Active Portfolio

As a user, I want portfolio-level risk metrics beyond beta so that I can size my
book using risk numbers I would actually use in a quant context.

## Acceptance Criteria

- [ ] The portfolio view shows VaR at configurable confidence levels.
- [ ] The portfolio view shows CVaR at configurable confidence levels.
- [ ] The portfolio view shows historical drawdown for the active allocation.
- [ ] The portfolio view shows a correlation matrix across held positions.
- [ ] The portfolio view shows an effective number of bets that accounts for
      correlations.
- [ ] A Monte Carlo simulation can project portfolio returns over a chosen
      horizon.
- [ ] All metrics use active position weights rather than raw net notional.
- [ ] Loading and failure states for each metric are visible.

## Related Work

- Issue [#74](https://github.com/data-cartel/moneymentum/issues/74) — risk
  analytics scope

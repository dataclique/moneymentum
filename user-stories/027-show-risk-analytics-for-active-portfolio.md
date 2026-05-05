---
status: planned
theme: risk-analytics
---

# Show Risk Analytics For Active Portfolio

As a user, I want portfolio-level risk metrics beyond beta so that I can size my
book using risk numbers I would actually use in a quant context.

## Acceptance Criteria

All risk metrics on this page share a common measurement contract so they
describe the same portfolio under the same assumptions:

- `measurement_window`: a lookback expressed as either `lookback_days` or an
  explicit `start_date`/`end_date` pair.
- `sampling_frequency`: e.g. daily or weekly.
- `confidence_levels`: array of confidence levels used by VaR and CVaR.
- Weighting: all metrics use active position weights, not gross notional.

The portfolio view displays the active window and frequency alongside the
metrics so the reader knows the baseline.

- [ ] The portfolio view shows VaR at the configured confidence levels.
- [ ] The portfolio view shows CVaR at the configured confidence levels.
- [ ] The portfolio view shows historical drawdown for the active allocation
      over the measurement window.
- [ ] The portfolio view shows a correlation matrix across held positions
      computed over the measurement window at the configured sampling
      frequency.
- [ ] The portfolio view shows an effective number of bets that accounts for
      correlations.
- [ ] A Monte Carlo simulation can project portfolio returns over a chosen
      horizon, with its inputs (window, frequency, sample count) shown
      alongside the result.
- [ ] All metrics use active position weights rather than raw net notional.
- [ ] All metrics display the active `measurement_window` and
      `sampling_frequency` so every number references the same baseline.
- [ ] Loading and failure states for each metric are visible.

## Related Work

- Issue [#74](https://github.com/data-cartel/moneymentum/issues/74) — risk
  analytics scope

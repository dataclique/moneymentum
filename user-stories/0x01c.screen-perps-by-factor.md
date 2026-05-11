---
status: planned
theme: screener-and-staged-simulation
---

# Screen Perps By Factor

As a user, I want to rank and filter perps by factor characteristics so that I
can build factor-driven portfolios instead of picking symbols manually.

## Acceptance Criteria

Each factor has a documented default sort direction so two callers with the same
data get the same order:

- Beta to benchmark: descending.
- Momentum: descending.
- Carry (signed funding): descending for a long bias, ascending when the short
  bias is selected.
- Realized volatility: ascending.
- Sharpe ratio: descending.

Ties are broken in a fixed sequence: 24h volume (descending), then market symbol
(ascending). Rows with missing values for the chosen factor are always sorted to
the bottom and tagged with a "missing" flag, regardless of sort direction. Sort
direction and tie-break order are exposed on the ranking API (e.g.
`rankPerpsByFactor` / `applyRankingFilter`) so callers can override defaults
explicitly.

- [ ] The screener can rank perps by beta to BTC (or another benchmark).
- [ ] The screener can rank perps by momentum over a configurable lookback
      period.
- [ ] The screener can rank perps by carry (funding rate, signed for the
      direction the user holds).
- [ ] The screener can rank perps by realized volatility.
- [ ] The screener can rank perps by Sharpe ratio.
- [ ] Assets with missing data for the chosen factor are visibly marked, always
      placed at the bottom, and never silently dropped.
- [ ] The user can apply the active ranking as a filter when constructing a
      target portfolio.

## Related Work

- Issue [#75](https://github.com/data-cartel/moneymentum/issues/75) -- screener
  scope

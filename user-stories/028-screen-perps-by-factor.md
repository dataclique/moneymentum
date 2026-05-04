---
status: planned
theme: screener-and-staged-simulation
---

# Screen Perps By Factor

As a user, I want to rank and filter perps by factor characteristics so that I
can build factor-driven portfolios instead of picking symbols manually.

## Acceptance Criteria

- [ ] The screener can rank perps by beta to BTC (or another benchmark).
- [ ] The screener can rank perps by momentum over a configurable lookback
      period.
- [ ] The screener can rank perps by carry (funding rate, signed for the
      direction the user holds).
- [ ] The screener can rank perps by realized volatility.
- [ ] The screener can rank perps by Sharpe ratio.
- [ ] Assets with missing data for the chosen factor are visibly marked rather
      than silently dropped.
- [ ] The user can apply the active ranking as a filter when constructing a
      target portfolio.

## Related Work

- Issue [#75](https://github.com/data-cartel/moneymentum/issues/75) — screener
  scope

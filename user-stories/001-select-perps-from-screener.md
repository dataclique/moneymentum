# Select Perps From The Screener

As a user, I want to be able to select perps from a searchable screener so that
I can build a target portfolio from the assets available on the venue.

## Why

The rebalancer starts with the universe of tradable symbols. A user needs a fast
way to find an asset, see basic funding context, and add it to the portfolio
without typing exchange-specific payloads by hand.

## Acceptance Criteria

- [ ] The screener lists available perp symbols returned by the trading data
      source.
- [ ] The user can search symbols case-insensitively.
- [ ] Selecting an unselected symbol adds it to the positions table.
- [ ] Already selected symbols are visibly disabled in the screener.
- [ ] Keyboard selection works with Enter or Space on a focused screener row.
- [ ] Funding rate, when available, is shown as an annualized rate next to the
      symbol.

## Notes

This story covers selection only. Ranking, factor filters, and advanced
screening belong in separate stories.

---
status: completed
epic: completed-rebalancer
priority: 1
tags:
  - user-story
---

# Select Perps From The Screener

As a user, I want to be able to select perps from a searchable screener so that
I can build a target portfolio from the assets available on the venue.

## Status

Completed.

## Acceptance Criteria

- [x] The screener lists available perp symbols returned by the trading data
      source.
- [x] The user can search symbols case-insensitively.
- [x] Selecting an unselected symbol adds it to the positions table.
- [x] Already selected symbols are visibly disabled in the screener.
- [x] Keyboard selection works with Enter or Space on a focused screener row.
- [x] Funding rate, when available, is shown as an annualized rate next to the
      symbol.

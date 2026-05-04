---
status: completed
epic: completed-rebalancer
priority: 2
tags:
  - user-story
---

# Edit Target Position Allocations

As a user, I want to be able to edit target position allocations by weight,
notional, side, and per-position leverage so that the portfolio expresses my
intended exposure before I rebalance.

## Status

Completed.

## Acceptance Criteria

- [x] The positions table shows each selected symbol, side, weight, notional,
      funding rate, and per-position leverage.
- [x] The user can change a position between long and short.
- [x] The user can edit a position weight as a percentage.
- [x] The user can edit a position notional in USD.
- [x] Weight edits update target notional consistently with total portfolio
      notional.
- [x] Notional edits update portfolio weights consistently with total selected
      notional.
- [x] Per-position leverage cannot exceed the venue leverage limit for that
      symbol.
- [x] Removing an existing exchange position stages a close instead of silently
      deleting it from the workflow.
- [x] Removing a newly added draft position removes it from the table.

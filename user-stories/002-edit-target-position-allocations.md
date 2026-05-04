# Edit Target Position Allocations

As a user, I want to be able to edit target position allocations by weight,
notional, side, and per-position leverage so that the portfolio expresses my
intended exposure before I rebalance.

## Why

Moneymentum models portfolios as proportions plus leverage. Editing positions
must keep that model visible while still allowing practical notional entry for
trading decisions.

## Acceptance Criteria

- [ ] The positions table shows each selected symbol, side, weight, notional,
      funding rate, and per-position leverage.
- [ ] The user can change a position between long and short.
- [ ] The user can edit a position weight as a percentage.
- [ ] The user can edit a position notional in USD.
- [ ] Weight edits update target notional consistently with total portfolio
      notional.
- [ ] Notional edits update portfolio weights consistently with total selected
      notional.
- [ ] Per-position leverage cannot exceed the venue leverage limit for that
      symbol.
- [ ] Removing an existing exchange position stages a close instead of silently
      deleting it from the workflow.
- [ ] Removing a newly added draft position removes it from the table.

## Notes

This story is about constructing the target portfolio. Execution belongs in the
rebalance story.

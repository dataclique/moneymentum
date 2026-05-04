# Preview Staged Rebalance Trades

As a user, I want to be able to preview staged rebalance trades so that I can
understand what will be sent before I execute.

## Why

Rebalancing is a destructive trading action. The user needs a clear preview of
which positions will be opened, increased, reduced, closed, or otherwise
modified before submitting orders.

## Acceptance Criteria

- [ ] Editing target allocations creates staged trade rows for changed
      positions.
- [ ] Each staged trade shows side, symbol, weight change, and notional change.
- [ ] Removing an existing position stages the opposite side needed to close it.
- [ ] Newly added positions show as staged trades.
- [ ] Unchanged positions do not appear in staged changes.
- [ ] The panel shows total notional before and after when the total changes.
- [ ] The user can clear staged changes and return to the loaded exchange
      portfolio.

## Notes

This story covers previewing intent. It should not send orders.

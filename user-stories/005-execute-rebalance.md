# Execute Rebalance

As a user, I want to be able to execute the staged rebalance so that my venue
positions move toward the target portfolio.

## Why

The portfolio tool is useful only if it can turn a reviewed target allocation
into venue orders. The execution step must be deliberate, visible, and tied to
the staged changes the user already reviewed.

## Acceptance Criteria

- [ ] The rebalance action is disabled when there are no staged trades.
- [ ] The rebalance action sends only positions that changed relative to the
      loaded exchange state.
- [ ] The submitted payload includes account value, cross-account leverage,
      precise mode, and target position weights.
- [ ] The UI marks submitted positions as working while orders are in flight.
- [ ] On success, the app refreshes account and position data from the venue.
- [ ] Once the refreshed exchange state matches the target, staged trades clear.
- [ ] On failure, the failed position shows the error message and remains
      reviewable.

## Notes

This story assumes Hyperliquid execution. Additional execution venues should be
modeled as separate stories.

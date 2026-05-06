---
status: completed
theme: completed-rebalancer
---

# Execute Rebalance

As a user, I want to be able to execute the staged rebalance so that my venue
positions move toward the target portfolio.

## Acceptance Criteria

- [x] The rebalance action is disabled when there are no staged trades.
- [x] The rebalance action sends only positions that changed relative to the
      loaded exchange state.
- [x] The submitted payload includes account value, cross-account leverage,
      precise mode, and target position weights.
- [x] The UI marks submitted positions as working while orders are in flight.
- [x] On success, the app refreshes account and position data from the venue.
- [x] Once the refreshed exchange state matches the target, staged trades clear.
- [x] On failure, the failed position shows the error message and remains
      reviewable.

## Related Work

- PR [#142](https://github.com/data-cartel/moneymentum/pull/142) -- placing
  order + rendering logic fixes

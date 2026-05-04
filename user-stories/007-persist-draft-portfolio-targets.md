---
status: completed
theme: completed-rebalancer
---

# Persist Draft Portfolio Targets

As a user, I want draft portfolio targets to persist locally so that refreshing
the app does not erase an unfinished rebalance plan.

## Acceptance Criteria

- [x] Draft portfolio state is stored per network mode.
- [x] Stored state includes selected symbols, weights, side, leverage, notional,
      and cross-account leverage.
- [x] On load, stored draft positions merge with exchange positions.
- [x] Exchange positions remain the source of truth for the initial comparison
      baseline.
- [x] Disconnecting the wallet clears local portfolio state for that network
      mode.
- [x] User preferences for precise mode and weight redistribution persist
      locally.

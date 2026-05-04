# Persist Draft Portfolio Targets

As a user, I want draft portfolio targets to persist locally so that refreshing
the app does not erase an unfinished rebalance plan.

## Why

Portfolio construction can take multiple iterations. Local persistence lets the
user resume a draft without treating it as exchange truth.

## Acceptance Criteria

- [ ] Draft portfolio state is stored per network mode.
- [ ] Stored state includes selected symbols, weights, side, leverage, notional,
      and cross-account leverage.
- [ ] On load, stored draft positions merge with exchange positions.
- [ ] Exchange positions remain the source of truth for the initial comparison
      baseline.
- [ ] Disconnecting the wallet clears local portfolio state for that network
      mode.
- [ ] User preferences for precise mode and weight redistribution persist
      locally.

## Notes

Persistence must not store credentials or secret material.

---
status: completed
epic: completed-rebalancer
priority: 3
tags:
  - user-story
---

# Adjust Account Leverage

As a user, I want to be able to adjust cross-account leverage so that total
target notional scales up or down while preserving portfolio weights.

## Status

Completed.

## Acceptance Criteria

- [x] The current cross-account leverage is visible near the portfolio controls.
- [x] The user can change leverage with a slider.
- [x] The user can type an exact leverage value.
- [x] Leverage is constrained to the supported account-level range.
- [x] Changing leverage recalculates target notional from account value times
      leverage.
- [x] Changing leverage preserves active position weights.
- [x] The staged changes panel shows leverage changes relative to the loaded
      exchange state.

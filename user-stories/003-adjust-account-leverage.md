# Adjust Account Leverage

As a user, I want to be able to adjust cross-account leverage so that total
target notional scales up or down while preserving portfolio weights.

## Why

The system treats a portfolio as weights multiplied by account-level leverage.
Changing leverage should scale exposure without forcing the user to recalculate
every position manually.

## Acceptance Criteria

- [ ] The current cross-account leverage is visible near the portfolio controls.
- [ ] The user can change leverage with a slider.
- [ ] The user can type an exact leverage value.
- [ ] Leverage is constrained to the supported account-level range.
- [ ] Changing leverage recalculates target notional from account value times
      leverage.
- [ ] Changing leverage preserves active position weights.
- [ ] The staged changes panel shows leverage changes relative to the loaded
      exchange state.

## Notes

This story does not add new risk constraints. Margin, liquidation, and venue
health checks belong in separate risk stories.

# Protect Invalid Rebalances

As a user, I want to be prevented from submitting invalid rebalances so that I
do not send orders that the venue will reject or that contradict the target
portfolio model.

## Why

Fast iteration is useful only when invalid states are blocked before execution.
The app should explain what prevents submission and keep the user in control of
the target.

## Acceptance Criteria

- [ ] Rebalance is blocked when account value is unavailable or zero.
- [ ] Rebalance is blocked when total target notional is below the venue
      minimum.
- [ ] Rebalance is blocked when selected positions cannot each satisfy the
      minimum notional.
- [ ] Rebalance is blocked when total weights are materially above 100%.
- [ ] Rebalance is blocked when total weights are materially below 100%.
- [ ] Positions below minimum notional show an inline warning.
- [ ] Non-precise mode blocks changes below the minimum change threshold and
      explains that precise mode can be used.
- [ ] Blocking reasons are visible near the portfolio controls.

## Notes

This story covers existing guardrails. More advanced checks, such as margin
health or liquidation distance, belong in risk stories.

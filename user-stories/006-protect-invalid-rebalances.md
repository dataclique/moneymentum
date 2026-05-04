---
status: completed
epic: completed-rebalancer
priority: 6
tags:
  - user-story
---

# Protect Invalid Rebalances

As a user, I want to be prevented from submitting invalid rebalances so that I
do not send orders that the venue will reject or that contradict the target
portfolio model.

## Status

Completed.

## Acceptance Criteria

- [x] Rebalance is blocked when account value is unavailable or zero.
- [x] Rebalance is blocked when total target notional is below the venue
      minimum.
- [x] Rebalance is blocked when selected positions cannot each satisfy the
      minimum notional.
- [x] Rebalance is blocked when total weights are materially above 100%.
- [x] Rebalance is blocked when total weights are materially below 100%.
- [x] Positions below minimum notional show an inline warning.
- [x] Non-precise mode blocks changes below the minimum change threshold and
      explains that precise mode can be used.
- [x] Blocking reasons are visible near the portfolio controls.

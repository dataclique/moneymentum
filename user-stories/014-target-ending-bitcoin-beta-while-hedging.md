---
status: planned
theme: full-bitcoin-beta-accounting
---

# Target Ending Bitcoin Beta While Hedging

As a user, I want to choose my ending beta to Bitcoin while constructing a hedge
so that I can decide how much market exposure remains after rebalancing.

## Acceptance Criteria

- [ ] The portfolio page shows current Bitcoin beta and target Bitcoin beta.
- [ ] The user can enter a desired ending Bitcoin beta.
- [ ] The app previews the hedge gap between current beta and target beta.
- [ ] Staged changes update the projected ending beta.
- [ ] If the requested target beta cannot be achieved with the current
      instrument universe and constraints, the portfolio page shows a clear
      "Cannot reach target with current universe/constraints" state, the
      projected ending beta preview marks the result as infeasible, the message
      names which constraint blocks the target (instrument coverage, liquidity,
      or maximum leverage), and the rebalance submit action is disabled until
      the target is achievable or revised.
- [ ] The app does not submit a rebalance solely because a target beta was
      entered; the user must still stage and submit trades.

---
status: planned
epic: full-bitcoin-beta-accounting
priority: 11
tags:
  - moneymentum/user-story
---

# Show Bitcoin Beta For The Active Portfolio

As a user, I want to see my portfolio beta to Bitcoin so that I can understand
whether my long-short book is actually hedged.

## Status

Planned.

## Acceptance Criteria

- [ ] The portfolio page requests Bitcoin beta for the active target portfolio.
- [ ] The UI shows beta beside the existing exposure summary.
- [ ] Loading and failure states are visible.
- [ ] The beta calculation uses active position weights, not raw net notional.
- [ ] Rebalancer edits update the displayed beta.

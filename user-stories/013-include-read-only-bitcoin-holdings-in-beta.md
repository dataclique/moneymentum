---
status: planned
epic: full-bitcoin-beta-accounting
priority: 13
tags:
  - user-story
---

# Include Read-Only Bitcoin Holdings In Beta

As a user, I want my read-only Bitcoin holdings included in beta so that the
portfolio risk view reflects my full exposure.

## Status

Planned.

## Acceptance Criteria

- [ ] Bitcoin balances from read-only addresses are converted into portfolio
      notional.
- [ ] The beta request includes Hyperliquid positions and read-only Bitcoin
      holdings.
- [ ] The UI distinguishes exchange positions from read-only holdings.
- [ ] Removing a read-only address updates total portfolio beta.
- [ ] Missing Bitcoin balance data is shown as a degraded risk calculation.

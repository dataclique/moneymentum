---
status: planned
epic: full-bitcoin-beta-accounting
priority: 12
tags:
  - user-story
---

# Add Read-Only Bitcoin Addresses

As a user, I want to add read-only Bitcoin addresses so that spot holdings in
those wallets count as part of my portfolio.

## Status

Planned.

## Acceptance Criteria

- [ ] The user can add a Bitcoin address without giving spend authority.
- [ ] The app validates the address format before saving it.
- [ ] The app fetches the address balance.
- [ ] The portfolio view shows read-only BTC holdings separately from
      Hyperliquid positions.
- [ ] The user can remove a read-only Bitcoin address.
- [ ] Address fetch failures are visible and do not block Hyperliquid portfolio
      use.

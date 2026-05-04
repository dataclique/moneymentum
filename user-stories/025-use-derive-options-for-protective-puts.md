---
status: planned
theme: crash-protection-and-simulation
---

# Use Derive Options For Protective Puts

As a long-term bullish Bitcoin user, I want to buy and manage protective put
options through Derive so that hedge positions are real market positions rather
than only manually tracked entries.

## Acceptance Criteria

- [ ] The user can browse Derive option chains for Bitcoin from the app.
- [ ] The user can buy a put option through a connected wallet.
- [ ] Open Derive option positions appear in the portfolio next to perp and spot
      positions.
- [ ] Option positions are valued at the current Derive mark price.
- [ ] The risk view includes Derive options alongside manually entered puts from
      [Story 019](./019-enter-protective-put-positions.md).
- [ ] Failed Derive interactions surface the underlying error to the user.

## Related Work

- PR [#158](https://github.com/data-cartel/moneymentum/pull/158) — Derive
  integration (DRAFT)

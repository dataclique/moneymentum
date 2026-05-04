---
status: planned
theme: vault
---

# Withdraw From Vault

As a user, I want to withdraw USDC from my vault shares so that I can take
capital out of the strategy when I choose to.

## Acceptance Criteria

- [ ] The user can submit `request_withdraw` to record withdrawal intent
      on-chain.
- [ ] Pending withdrawals show their unlock time based on the redeem period.
- [ ] After the redeem period elapses, the user can execute the withdrawal and
      receive USDC.
- [ ] The settled withdrawal accounts for management and performance fees before
      the USDC payout.
- [ ] Burned shares are removed from the user's portfolio view.
- [ ] Failed withdrawals surface the on-chain error.

## Related Work

- PR [#122](https://github.com/data-cartel/moneymentum/pull/122) — vault program
  architecture (DRAFT)
- Issues [#127](https://github.com/data-cartel/moneymentum/issues/127),
  [#128](https://github.com/data-cartel/moneymentum/issues/128),
  [#132](https://github.com/data-cartel/moneymentum/issues/132) — fee math,
  two-phase withdrawal, withdraw UI

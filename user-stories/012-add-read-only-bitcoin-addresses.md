---
status: planned
theme: full-bitcoin-beta-accounting
---

# Add Read-Only Bitcoin Addresses

As a user, I want to add read-only Bitcoin addresses so that spot holdings in
those wallets count as part of my portfolio.

## Acceptance Criteria

- [ ] The user can add a Bitcoin address without giving spend authority.
- [ ] The app validates the address format before saving it.
      `validateBitcoinAddress(address, network)` accepts P2PKH, P2SH, and Bech32
      (segwit) addresses on mainnet and testnet, returns `Ok(kind)` on success,
      and returns a typed error on failure. The UI surfaces invalid addresses
      with the message "Invalid Bitcoin address" without blocking other
      portfolio actions; the validation error is logged. Unit tests cover at
      least one valid address per supported kind on mainnet and testnet, plus
      rejection cases (truncated, wrong checksum, wrong network) asserting the
      exact error message.
- [ ] The app fetches the address balance.
- [ ] The portfolio view shows read-only BTC holdings separately from
      Hyperliquid positions.
- [ ] The user can remove a read-only Bitcoin address.
- [ ] Address fetch failures are visible and do not block Hyperliquid portfolio
      use.

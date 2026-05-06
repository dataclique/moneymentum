---
status: planned
theme: portfolio-identity-and-sharing
---

# Authenticate Portfolio Ownership By Solana Pubkey

As a user, I want to authenticate cryptographically with a Solana wallet so that
my portfolio can be identified by my public key.

## Acceptance Criteria

- [ ] The user can sign in by proving control of a Solana public key using a
      Sign-In With Solana (SIWS) style challenge.
- [ ] The signature challenge cannot be replayed: the server issues a
      single-use, cryptographically random nonce bound to the requesting address
      with a short expiry, rejects expired or already-used nonces, and verifies
      the signed message recovers the same public key.
- [ ] Sign-in supports the wallets the app already integrates with (e.g.
      Phantom, Solflare) and surfaces clear errors for signature rejection and
      wallet disconnection.
- [ ] Sessions have an explicit lifetime and refresh policy: the story defines a
      session TTL, the renewal/re-sign behavior at expiry, multi-device session
      semantics, and how sessions are revoked.
- [ ] The portfolio identifier is the authenticated Solana public key.
- [ ] The app stores portfolio metadata under that identifier. "Portfolio
      metadata" is a defined schema covering at least: portfolio settings (e.g.
      target beta, risk preferences), positions split into staged drafts and
      current/active positions, snapshot policy (latest-only or timestamped
      historical snapshots), and user preferences (UI theme, notification
      settings). Backend persistence and frontend state share this contract.
- [ ] Signing in does not require deposit or trading authority.

## Related Work

- PR [#120](https://github.com/data-cartel/moneymentum/pull/120) -- wallet trait
  and mock (DRAFT, preparatory infra)
- PR [#121](https://github.com/data-cartel/moneymentum/pull/121) -- Turnkey EVM
  wallet (DRAFT, preparatory infra)

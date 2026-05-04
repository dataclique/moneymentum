# Authenticate Portfolio Ownership By Solana Pubkey

As a user, I want to authenticate cryptographically with a Solana wallet so that
my portfolio can be identified by my public key.

## Status

Planned.

## Acceptance Criteria

- [ ] The user can sign in by proving control of a Solana public key.
- [ ] The signature challenge cannot be replayed.
- [ ] The portfolio identifier is the authenticated Solana public key.
- [ ] The app stores portfolio metadata under that identifier.
- [ ] Signing in does not require deposit or trading authority.

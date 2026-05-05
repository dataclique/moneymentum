---
status: planned
theme: portfolio-identity-and-sharing
---

# View Portfolios By Public Key URL

As a user, I want a portfolio to be viewable at `/<pubkey>` so that I can share
or revisit a portfolio by its owner identifier.

## Acceptance Criteria

- [ ] Visiting `/<pubkey>` validates the pubkey against Solana address format
      before any backend lookup, with pubkeys URL-encoded/decoded consistently
      in links and route handling.
- [ ] An invalid address shows a distinct "Invalid address format" state and
      does not trigger a portfolio lookup.
- [ ] A well-formed pubkey with no portfolio shows a distinct "Portfolio not
      found" state, kept separate from the invalid-format state.
- [ ] Visiting `/<pubkey>` loads the portfolio for that public key when one
      exists.
- [ ] Public portfolio data can be viewed without signing in when the portfolio
      is public. The story defers the public/private visibility model and
      default to [Story 017](./017-hide-portfolio-details-for-fee.md);
      unauthenticated visits to a private portfolio behave per that story.
- [ ] The route does not expose private configuration or credentials.
- [ ] The owner can still authenticate to edit portfolio settings.

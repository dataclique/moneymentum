---
status: planned
theme: portfolio-identity-and-sharing
---

# View Portfolios By Public Key URL

As a user, I want a portfolio to be viewable at `/<pubkey>` so that I can share
or revisit a portfolio by its owner identifier.

## Acceptance Criteria

- [ ] Visiting `/<pubkey>` loads the portfolio for that public key.
- [ ] Unknown public keys show a clear not-found state.
- [ ] Public portfolio data can be viewed without signing in when the portfolio
      is public.
- [ ] The route does not expose private configuration or credentials.
- [ ] The owner can still authenticate to edit portfolio settings.

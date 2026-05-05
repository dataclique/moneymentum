---
status: planned
theme: spot-trading
---

# Add Read-Only Wallets On Other Chains

As a user, I want to add read-only wallets on other chains so that non-Bitcoin
holdings can become part of my portfolio view.

## Acceptance Criteria

- [ ] The wallet form supports at least one non-Bitcoin chain.
- [ ] The app validates addresses according to the selected chain.
- [ ] The app fetches token balances for the selected chain.
- [ ] The portfolio view labels holdings by chain and asset.
- [ ] Unsupported tokens are visible as unsupported instead of silently ignored.
- [ ] Read-only wallets cannot sign or submit transactions: the wallet form
      and portfolio view expose no signing controls or private-key import
      flow for read-only entries, and any server- or client-side request to
      sign or broadcast a transaction using a read-only wallet identifier is
      rejected before reaching a venue or chain RPC.

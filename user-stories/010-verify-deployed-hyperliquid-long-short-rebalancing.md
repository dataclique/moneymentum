---
status: planned
theme: usable-production-deployment
---

# Verify Deployed Hyperliquid Long-Short Rebalancing

As a user, I want to put up a long-short portfolio on Hyperliquid from the
deployed app so that I can manage real positions without running the project
locally.

## Acceptance Criteria

All deployed verification runs against a designated low-risk test account (or
testnet-equivalent where Hyperliquid offers one) with explicit, documented
funding caps; live-fund verification only proceeds with prior approval and a
documented rollback path.

- [ ] A smoke test or runbook exists for deployed wallet connection, restricted
      to the designated test account.
- [ ] A smoke test or runbook exists for verifying that the deployed app loads
      Hyperliquid account value and positions for the test account.
- [ ] A smoke test or runbook exists for verifying that a user can construct
      long and short target positions within the documented funding cap.
- [ ] A smoke test or runbook exists for verifying that staged trades appear
      before submission.
- [ ] A smoke test or runbook exists for verifying that rebalance submission
      works from the deployed app, with the test-mode toggle enforced so live
      funds cannot be used unintentionally.
- [ ] A smoke test or runbook exists for verifying that positions refresh after
      rebalance.
- [ ] **Safety & Rollback**: the runbook names the designated test account, the
      per-run notional cap, the deploy-config flag that enforces test mode
      (preventing live-fund execution unless explicitly disabled), the named
      approver(s) who may authorize a live check, and the documented procedure
      to revert or close any positions opened during verification.

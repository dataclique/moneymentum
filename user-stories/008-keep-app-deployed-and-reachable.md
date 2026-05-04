---
status: planned
theme: usable-production-deployment
---

# Keep The App Deployed And Reachable

As a user, I want to be able to use the platform so that Moneymentum is not just
a local development tool.

## Acceptance Criteria

- [ ] The repository contains deployment configuration for the frontend.
- [ ] The repository contains deployment configuration for the backend required
      by the frontend.
- [ ] Frontend configuration points at the deployed backend through checked-in
      configuration, not manual local edits.
- [ ] The backend exposes a smoke-testable health endpoint.
- [ ] CI or deployment checks fail visibly when the deploy configuration is
      invalid.
- [ ] The README documents the master-branch deployment flow.

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
- [ ] Automated post-deploy smoke verification: a CI job runs after deployment,
      issues HTTP GETs to the deployed frontend URL and the backend `/health`
      endpoint from the public network, and fails the pipeline if either does
      not return a healthy status.
- [ ] The README documents the master-branch deployment flow, including the
      post-deploy verification job and how to interpret its failures.

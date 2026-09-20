# Contributing

This guide covers Moneymentum's story workflow, TTDD, validation, and
pull-request requirements for human and AI contributors. See
[AGENTS.md](./AGENTS.md) for code-style, testing, and version-control rules
(including the mandatory GitButler `but` CLI), and [SPEC.md](./SPEC.md) for the
architectural vision.

---

## The Story Contract

A story is the unit of value. Every change starts from a story in
[stories/](./stories/README.md); see [Story Format](#story-format) for the file
template. A story is scoped to the value it delivers, not to a single PR; large
stories decompose into PR-sized GitHub issues tracked as sub-issues of the
story's parent issue. Keep each issue pull-request sized: one issue, one PR.

User-facing and internal dev stories share a single hex-indexed sequence (e.g.
`0x00b`), so they sort and cross-reference consistently.

**Entering a story**: Before writing any code, the agent reads the full story
including context. If anything in the acceptance criteria or context is
ambiguous, the agent asks the human to resolve it -- in the session, not in a
comment buried in a PR.

**Scope**: The story defines the boundary. If implementation reveals that
adjacent code needs to change to make the story work correctly, the agent notes
it and asks whether to extend the story or create a new one. It does not
silently expand scope. Refactor only when it supports the story being delivered.

**Tests**: Write the failing test before changing behavior. Docs-only,
metadata-only, and exploratory spike changes may skip the failing test, but the
PR description must say so and flag any footguns the change introduces.

**Done**: A story is done when every acceptance criterion passes and every
quality gate is green -- see [Done Means](#done-means) for the full auditable
contract. Marking a story done with failing tests or suppressed lints is a
contract violation.

### Exception: standalone refactors, migrations, and infrastructure work

"Every change starts from a story" assumes a user-facing story drives the work.
Some legitimate changes do not have one: framework migrations, internal
refactors, build/CI/infra cleanup. The sanctioned path for these is a **dev
story** -- a story that lives in [stories/](./stories/README.md) alongside user
stories (the index is shared and hex-numbered), listed under the "Dev"
sub-heading. A dev story plays the same role for foundational work that a user
story plays for user-facing features: a written contract with acceptance
criteria.

A PR submitted under this exception must:

- Reference its dev story (or the GitHub issue, if the change is small enough
  that a story is overkill) in the PR description.
- Include a short charter: **purpose** (why now), **risk** (what could break),
  and **rollback / migration plan** (how we undo it or move data forward).
- Be covered by CI and tests, or state explicitly in the PR description why
  tests are infeasible (e.g. a build-system change with no behavioral surface).
- Carry a `refactor` or `migration` label so reviewers know which expectations
  apply.

---

## Story Format

```markdown
---
status: completed | planned
---

# Short Story Name

As a user, I want to ...

## Acceptance Criteria

- [x] Completed or planned behavior
```

Use `As a portfolio manager...`, `As a reviewer...`, or another specific role
when "user" is too vague.

---

## TTDD Workflow

See [AGENTS.md](./AGENTS.md) for the full TTDD (Type-driven TDD) sequence and
the exact gate commands. Short version:

1. Types and signatures first -- model the domain before writing logic.
2. Failing tests second -- tests that compile and fail, not build errors.
3. Implementation third -- make the tests pass.

Run `cargo check` continuously during steps 1 and 2. Quality gates run at the
end before the PR.

---

## Quality Gates

These are non-negotiable. No story is done until all gates are green. Agents do
not suppress warnings, disable lints, or comment out tests to make gates pass.
If a gate failure reveals a genuine false positive or a lint that conflicts with
project policy, the agent surfaces it to the human and waits for explicit
permission before suppressing anything.

The gates are the Rust checks (`cargo check`, `cargo test`, `cargo clippy`,
`cargo fmt`) and the frontend checks (`bun run typecheck`, `bun run lint`,
`bun run test --run`, run from `frontend/`). [AGENTS.md](./AGENTS.md) is the
authoritative source for the exact commands and their order -- this list defers
to it so the two cannot drift.

---

## Done Means

A story is done when a reviewer can audit each item below from the PR alone:

- **Acceptance criteria are satisfied**, with a checked-off list in the PR
  description (or a link to the story file showing all boxes ticked) and a
  pointer to the PR that satisfied each criterion if more than one PR was
  needed.
- **Tests cover the behavior** where practical. The PR description names the
  test files or test IDs that exercise the behavior (e.g.
  `tests/rebalance_e2e.rs::rebalances_long_short_within_tolerance`,
  `frontend/src/components/__tests__/Screener.test.tsx`).
- **A validation note** describes how a reviewer can verify the acceptance
  criteria beyond running the test suite -- either manual steps (with concrete
  inputs and expected outputs) or the name of the CI job that gates the change
  (e.g. `ci / e2e-hyperliquid-testnet`).
- **Errors and disabled states are visible** in the change.
- **The diff contains only story-related changes.**
- **Relevant checks pass.**

Example footer for a PR description:

```markdown
### Done Means

- Acceptance criteria: all boxes ticked in
  stories/0x00b.show-bitcoin-beta-for-active-portfolio.md
- Tests: src/beta_handler.rs::beta_handler_returns_active_weighted_beta,
  frontend/src/**tests**/BetaCard.test.tsx
- Validation: run `cd frontend && bun run dev`, connect testnet wallet with a
  50/50 BTC/ETH portfolio, beta card should read ~0.95
- CI: ci / backend-tests, ci / frontend-tests
```

---

## Pull Requests

All version-control writes in this repo go through the GitButler `but` CLI --
never plain `git add`/`git commit`/`git push`/`git checkout`/`git rebase`. See
[AGENTS.md](./AGENTS.md) and
[ai/skills/gitbutler/SKILL.md](./ai/skills/gitbutler/SKILL.md) for the command
reference.

- One issue, one PR. If an issue required prerequisite refactoring, that
  refactoring is a separate PR that lands first.
- The PR description explains WHY the change exists -- what problem it solves --
  not what changed. Changes are visible in the diff.
- **Every PR `Closes` a problem-only GitHub issue**, and that issue is a
  checklist item in the relevant [ROADMAP.md](./ROADMAP.md) section linking both
  the issue and the PR. A PR without them is untracked work. The `pr-tracking`
  skill makes a whole stack conform.
- Reference the story ID (e.g. `0x00b`) in the PR description.
- Every PR that belongs to a multi-branch stack carries the GitButler
  stack-navigation footer; refresh it with `nix run .#pr-stack-footer` after any
  operation that reshapes the stack.
- Do not add "Generated with [Tool Name]" anywhere. Authorship is implicit in
  the commit history.
- PRs require human review. Agent review does not replace human review before
  merge.

---

## Intake

When new behavior is described, write the story first, then decompose it into
PR-sized issues. If the product decision is unclear, stop and ask before coding.

---

## Agent Boundaries

What agents own:

- Code and test changes inside this repo.
- Raising questions and blockers to the human.
- Running quality gates and reporting results.
- Proposing refactors within the scope of the current story.

What humans own:

- Prioritization and story selection.
- Accepting or rejecting completed stories.
- Architectural decisions that span multiple stories.
- Production deploys, secrets management, and external system configuration.
- Any action that is irreversible or affects systems outside this repo.

When an agent hits the boundary of its ownership -- a decision it cannot make
from the story and context alone -- it stops and asks. Guessing is not
acceptable when the cost of being wrong is real.

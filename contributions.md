# Contributions

Moneymentum uses AI-era extreme programming: small stories, tests first, tight
feedback, and frequent review by humans and agents.

## Rules

- Start every change from a user story in
  [User Stories](./user-stories/README.md).
- Keep each story pull-request sized.
- Make acceptance criteria verifiable before merge; do not require a follow-up
  PR just to mark the story done.
- Write the failing test before changing behavior.
- Pair while implementing: human and AI, AI and AI, or human driver with AI
  reviewer.
- Review before handoff. Reviews should find bugs, missing tests, and unclear
  product behavior.
- Refactor only when it supports the story being delivered.

## Story Format

```markdown
---
status: completed | planned
theme: <theme-slug>
---

# Short Story Name

As a user, I want to ...

## Acceptance Criteria

- [x] Completed or planned behavior
```

Use `As a portfolio manager...`, `As a reviewer...`, or another specific role
when "user" is too vague.

## Done Means

- Acceptance criteria are satisfied.
- Tests cover the behavior where practical.
- Errors and disabled states are visible.
- The diff contains only story-related changes.
- Relevant checks pass.

## Intake

When new behavior is described, split it into PR-sized stories first. If the
product decision is unclear, stop and ask before coding.

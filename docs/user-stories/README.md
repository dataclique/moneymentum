# User Stories

These documents group Moneymentum user stories by theme. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for repository contribution
requirements, TTDD, quality gates, and agent boundaries.

## Themes

Themes group related stories and their architectural context. They have no
status, owner, or lifecycle of their own.

| File                | Theme          | Prefix |
| ------------------- | -------------- | ------ |
| `portfolio-beta.md` | Portfolio Beta | PB     |
| `risk-analytics.md` | Risk Analytics | RA     |
| `screener.md`       | Screener       | SC     |
| `spot-trading.md`   | Spot Trading   | ST     |

Story ordering within a theme file does not authorize implementation. The human
owner selects the work.

## Story Format

Each story follows this structure:

```
## US-XX: Title

**As a** [role]
**I want** [capability]
**So that** [benefit]

### Acceptance criteria

- [ ] Concrete, observable, testable condition.
- [ ] Another condition. Each criterion must be independently verifiable.

### Context

Everything an agent needs to implement this story without asking basic
questions. Relevant files, API contracts, architectural decisions, constraints,
and prior art. Do not summarize what the story says -- add information the
story does not contain.

### Tasks

Technical breakdown, written by a developer or agent after reading the story.
These are HOW, not WHAT. They should be small enough that each can be verified
independently.

- [ ] Task description.

### Status

`backlog` | `in progress` | `done`
```

## Field Guide

**ID** (`US-XX`): Theme prefix plus two-digit number. Assigned sequentially
within a theme. Used to reference stories in PR descriptions, commit messages,
and GitHub issues. Never reuse an ID, even if a story is removed.

**Acceptance criteria**: Written before implementation begins. Each criterion
describes one observable outcome, not an implementation detail. Criteria must be
independently verifiable and together define when the story is done. Use the
running system or test results to verify them.

**Context** includes:

- Relevant source files (paths relative to repo root)
- Existing API contracts the story depends on (request/response shape)
- Architectural decisions that constrain the implementation
- Known edge cases or gotchas
- What has already been tried if this story is a retry

**Tasks**: Optional at story creation. Tasks are implementation-level and may
change during implementation. Acceptance criteria may not change without the
human owner's approval.

**Status**: Updated as work progresses.

- `backlog` -- written, not yet selected for an iteration.
- `in progress` -- selected for the current iteration, actively being
  implemented.
- `done` -- all acceptance criteria verified, PR merged.

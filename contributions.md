# Contributions

Moneymentum is moving toward an AI-era form of extreme programming. The goal is
to keep the project structured enough that humans and agents can make small,
reviewable changes without losing the product intent.

## Working Agreement

Every change starts from a user story. A story describes the user outcome, the
reason it matters, and the acceptance criteria that prove the behavior exists.
Stories should be small enough for one pull request.

Work stays close to the XP loop:

- Story: describe the user-visible behavior before implementation.
- Test: write a failing test for the story before changing behavior.
- Pair: work with another intelligence while implementing. The pair can be a
  human and AI, two AI agents, or a human driver with an AI reviewer.
- Integrate: keep changes small, mergeable, and continuously verified.
- Review: use review agents and human review to find bugs, missing tests, and
  unclear product behavior.
- Refactor: improve structure only where it directly supports the story.

## AI Pairing Modes

### Human and AI Pair

Use this when the product direction is still being shaped. The human owns
intent, tradeoffs, and acceptance of behavior. The AI owns rapid code reading,
test drafting, implementation, and surfacing architectural consequences.

### AI and AI Pair

Use this when the story is already clear. One agent implements a narrow change
while another reviews the diff or investigates a separate area. Agents must keep
ownership boundaries explicit so their edits do not collide.

### Review Agent

Use this after implementation and before handoff. The review agent should act
like a strict code reviewer: bugs first, missing tests second, polish last. A
review is only useful when it points to specific files and concrete behavior.

### Planning Agent

Use this before implementation when a request needs to be split into stories.
The planning agent turns product intent into PR-sized stories with acceptance
criteria and identifies dependencies between stories.

## Story Format

Stories live in `user-stories/`. Each file should use this shape:

```markdown
# Short Story Name

As a user, I want to ...

## Why

...

## Acceptance Criteria

- [ ] ...
- [ ] ...

## Notes

...
```

The first sentence must start with "As a user, I want to..." unless the user is
more specific, such as "As a portfolio manager" or "As a reviewer".

## Story Sizing

A story is pull-request sized when it can be reviewed without understanding an
unrelated feature. Prefer stories that touch one workflow boundary:

- Selecting positions
- Editing target allocations
- Previewing staged changes
- Executing a rebalance
- Showing risk or analytics for the current portfolio

If a story needs new backend behavior, frontend UI, and migration work, split it
unless those pieces cannot be useful independently.

## Definition of Done

A story is done when:

- The acceptance criteria are covered by tests where practical.
- The UI or API behavior matches the story without hidden defaults.
- Errors and disabled states are visible to the user.
- The diff contains only changes needed for the story.
- The relevant checks pass.

## Story Intake

When new product behavior is described, first turn it into one or more stories
in `user-stories/`. Keep story order meaningful: the next thing to implement
should be easiest to identify from the directory and filenames.

If behavior is ambiguous, stop and ask for the missing product decision before
coding. Do not bury product choices inside implementation details.

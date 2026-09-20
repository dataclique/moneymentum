# Contributing

Work in small increments: define the outcome, write failing tests, implement,
and verify. [AGENTS.md](./AGENTS.md) defines code style, exact quality commands,
and version control. [SPEC.md](./SPEC.md) describes the target system;
[ROADMAP.md](./ROADMAP.md) orders delivery.

## Planning and issue contracts

Use [GitHub issues](https://github.com/dataclique/moneymentum/issues) as the
backlog. Requirements and acceptance criteria live in issues, not Markdown story
files. Use parent issues for larger outcomes and sub-issues for independently
deliverable work. Reuse existing issues and retain their discussion, status, and
PR links.

Each issue describes the problem, relevant context, and observable acceptance
criteria. Implementation decisions belong in the implementation work, not a
prescribed solution in the problem statement. Internal refactors and migrations
use the same issue workflow; they do not need a separate story format or index.

Before changing code, read the issue, its parent and sub-issues, and the
relevant specification. Clarify unresolved product decisions before
implementation. Do not silently expand scope; proposed adjacent work requires a
scope decision or a separate issue. Refactoring must support the assigned
outcome.

The project owner sets priorities, reflected in the roadmap. Issue numbers do
not imply priority, and backlog items are not a schedule.

Contributions are evaluated by scope, correctness, and verification, whether
written manually or with AI assistance. No AI tool or harness is required.

## Types and tests before implementation

Follow the full TTDD sequence and Nix environment rules in
[AGENTS.md](./AGENTS.md):

1. Define domain types and signatures.
2. Write tests that compile and fail for the missing behavior.
3. Implement the behavior and refine the tests.

Run `cargo check` throughout type and test development. Use the repository's
Rust and frontend quality gates before delivery. Documentation-only,
metadata-only, and exploratory changes may omit behavioral tests when the PR
explains why and identifies relevant risks.

Do not suppress warnings, disable lints, or remove tests to make checks pass. A
suspected false positive or conflict with project policy requires explicit
permission before suppressing a check.

## Completion evidence

An issue is complete when a reviewer can verify:

- Every acceptance criterion is satisfied, with links to the implementing PRs.
- Tests exercise the behavior, with relevant test files or test identifiers.
- A validation note gives concrete inputs and expected outcomes, or identifies
  the applicable check that demonstrates the result.
- Errors, unavailable data, and disabled states are visible where applicable.
- The diff stays within the authorized scope and relevant checks pass.

Keep parent status consistent with remaining sub-issues. Checked subtasks do not
prove an unstated outcome; record missing work explicitly. Retain evidence for
completed work and distinguish cancellation from completion.

## Pull requests

Use the repository's GitButler workflow in [AGENTS.md](./AGENTS.md). One
deliverable issue corresponds to one PR; a larger parent may span several.
Required prerequisite refactoring is a separate PR that lands first.

- Every PR closes its problem issue and links the parent when applicable.
- Link the issue and PR in the relevant roadmap checklist; the completion tick
  lands with the implementing PR.
- Explain the problem and approach using the repository's PR format. Internal
  refactors and migrations also identify purpose, risk, and rollback or
  migration considerations; use the appropriate category label.
- Maintain the GitButler stack-navigation footer, refreshing it with
  `nix run .#pr-stack-footer` when a stack changes.
- Keep README, SPEC, ROADMAP, issues, and contributor guidance consistent with
  the change. Do not recreate an in-repository story index.
- Do not add generated-by or co-author credit for an agent.

Maintainer review is required before merge.

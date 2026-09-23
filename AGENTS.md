# AGENTS.md

## Project Direction

This project is an institutional-grade quant toolkit. See [SPEC.md](./SPEC.md)
for the vision and [ROADMAP.md](./ROADMAP.md) for the path.

### Agent expectations

The project owner sets priorities. Work within the assigned issue, surface
blockers, and verify delegated work against its acceptance criteria. Do not
submit review verdicts on anyone's behalf. Tool choice does not grant authority
over deployment or external systems; no particular AI harness is required.

AI coding agents working in this repo are expected to:

- Read [ROADMAP.md](./ROADMAP.md) and the relevant
  [GitHub issue](https://github.com/dataclique/moneymentum/issues), including
  its parent and sub-issues, before changing code. The issue's acceptance
  criteria are the contract. Do not create Markdown story files or a duplicate
  backlog.
- Follow [CONTRIBUTING.md](./CONTRIBUTING.md): types-first, failing test,
  implementation, review.
- Honor the rules in this document for code style, testing, and quality gates.
- Edit code, tests, and configs in this repo. Humans own deploys, secrets, and
  external systems outside git.
- Run every toolchain command (`bun`, `cargo`, `sqlx`, `but`, ...) through the
  Nix flake -- see [Environment: Nix first](#environment-nix-first). Do not try
  bare `bun` / `cargo` first and fall back to Nix after failure.
- Never relax quality checks (clippy, eslint, tests) without explicit
  permission. Ask if a check seems wrong; don't suppress.
- Don't substitute approaches, libraries, or tools without checking in. Scope is
  whatever was asked, not whatever you'd prefer.

For status -- what works today vs. what's planned -- see
[README.md](./README.md) and [ROADMAP.md](./ROADMAP.md).

**Key architectural decisions:**

- **All Rust**: Official SDKs for Hyperliquid, Derive, deBridge, Jupiter. Polars
  for analytics. Single language from API to blockchain interactions.
- **Frontend holds credentials**: Backend generates execution plans, frontend
  executes. Credentials never leave the browser.
- **Portfolios as proportions**: Target portfolios are defined as weights +
  leverage, not dollar amounts. Rebalancing = return to target proportions.

---

## Development Commands

### Environment: Nix first

Use the repository's Nix toolchain for all development commands. Verify that the
command shell has the flake environment active; otherwise, use an explicit flake
shell from the repository root. Do not install global tools or bypass Nix for
dependency management. Use the frontend-only shell (`.#frontend`) when Rust
tooling is unnecessary. When direnv has activated the flake environment, run
toolchain commands directly.

### Frontend (SolidJS + Vite)

From repo root, via Nix:

```bash
nix --impure develop -c bash -lc 'cd frontend && bun run typecheck'  # Type check only
nix --impure develop -c bash -lc 'cd frontend && bun run lint'       # Lint
nix --impure develop -c bash -lc 'cd frontend && bun run test'       # Run tests (vitest)
nix --impure develop -c bash -lc 'cd frontend && bun run build'      # Full build
nix --impure develop -c bash -lc 'cd frontend && bun run dev'        # Dev server (port 5173) - only when explicitly asked
```

Inside an already-active flake shell, the same scripts run from `frontend/` as
`bun run <script>`.

### Backend (Rust)

From repo root, via Nix:

```bash
nix --impure develop -c cargo check              # Fast compilation verification
nix --impure develop -c cargo test -q            # Run tests
nix --impure develop -c cargo clippy             # Linting
nix --impure develop -c cargo fmt                # Format code
```

Inside an already-active flake shell, bare `cargo ...` is fine.

**Workflow (TTDD - Type-driven TDD)**:

TTDD sequence:

1. **Types first**: Define types, traits, and method signatures that model the
   domain
2. **Failing tests**: Write tests that compile but fail (build errors don't
   count as failing tests)
3. **Implementation**: Write the logic to make tests pass

While developing, continuously run `cargo check` and `cargo test` to verify
types and behavior. Only after implementation is complete, run `cargo clippy`
and fix all warnings. Finally, `cargo fmt` before committing.

**CRITICAL: Never use `cargo build` for verification.** Use `cargo check`
(faster) or `cargo test` (more useful). Only use `cargo build` when you need the
binary.

**Dependencies**: Always use `cargo add <crate>` - never manually edit
Cargo.toml versions. Run `cargo add` through the flake shell
(`nix --impure develop -c cargo add <crate>`).

**Migrations**: Never manually create migration files. Always use sqlx CLI
(through the flake shell):

```bash
nix --impure develop -c sqlx migrate add <migration_name>  # Creates timestamped migration file
nix --impure develop -c sqlx migrate run                   # Applies pending migrations
```

### Version control

All write operations go through the GitButler CLI (`but`) -- never `git add`,
`git commit`, `git push`, `git checkout`, `git rebase`, or other git writes.
Read-only git inspection (`git status`, `git log`, `git diff`) is fine. See
[ai/skills/gitbutler/SKILL.md](./ai/skills/gitbutler/SKILL.md) for the full
command reference and workflow.

---

## Workflow & Policies

### When issues are pointed out

Fix immediately. The user never sends messages just for the sake of it.

### No self-promotion

Never add "Generated with [Tool Name]" to commits, PRs, or code.

### PR titles and descriptions

**Titles**: Lowercase, imperative, concise. Describe the outcome, not the
mechanism. No prefixes like `feat:` or `fix:`.

- Good: `migrate frontend from React to SolidJS`
- Good: `replace exceptions with typed Effect errors`
- Bad: `Add Effect library for functional HTTP error handling`
- Bad: `Refactor API hooks to use Effect-based error handling`

**Descriptions**: Two sections -- `## Why` and `## How`.

- **Why**: The problem or motivation. Why does this PR exist?
- **How**: High-level approach. Explain the solution, not the file changes --
  the diff tab handles that. No file paths, no bullet lists of changes.

```
## Why

<1-3 sentences explaining the problem or motivation>

## How

<1-3 sentences explaining the approach and key decisions>
```

### Every PR is tracked by an issue and the roadmap

Every PR `Closes` a problem-only GitHub issue, and that issue is a checklist
item in the relevant [ROADMAP.md](./ROADMAP.md) section linking the issue and
the PR. Keep the roadmap in lockstep: the entry and its tick land on the feature
PR itself, so the roadmap always matches what merged. The `pr-tracking` skill
makes a whole stack conform.

### Every stacked PR carries the GitButler stack footer

Keep the GitButler stack-navigation footer current on every stacked PR. Run
`nix run .#pr-stack-footer` after operations that reshape the stack; a no-op
push does not refresh it.

### Documentation stays in lockstep with the code

Every PR must leave the documentation in a true state. Before handing off work
-- requesting review, marking a task done, declaring a story complete -- audit
the docs that touch what you changed and update anything that has gone stale.

Concrete audit checklist:

- [README.md](./README.md): does it still describe the system accurately (status
  of components, doc index)?
- [SPEC.md](./SPEC.md): does it describe the intended system without delivery
  status, incident history, or obsolete scope?
- [ROADMAP.md](./ROADMAP.md): are completed items marked completed, are new
  themes/stories listed, are stale ones removed?
- [GitHub issues](https://github.com/dataclique/moneymentum/issues): are the
  acceptance criteria, parent/sub-issue links, and completion evidence current?
- [CONTRIBUTING.md](./CONTRIBUTING.md) and `AGENTS.md`: did a rule change in
  practice? If so, the rule changes here first.
- Per-file CLAUDE.md / AGENTS.md (e.g. `frontend/CLAUDE.md`): same audit at the
  subtree level.
- Inline doc comments and module-level docstrings on any code you touched.

If a doc has fallen out of sync with reality and is not directly in your
change's path, either fix it in the same PR (preferred) or open a follow-up
issue immediately -- do not leave silent drift.

Stale documentation is a bug. Treat it like any other defect: do not ship work
that introduces it, and do not ignore it when you see it.

### Quality checks

**NEVER disable or relax any quality checks without explicit permission.** This
applies to:

- Clippy lints (`#[allow(clippy::*)]`)
- Compiler warnings (`#[allow(dead_code)]`, `#[allow(unused)]`)
- All linters in all languages (eslint, clippy, etc.)
- Test coverage - should not decrease without permission

Fix the underlying code, don't suppress warnings.

**When permission IS appropriate:** If fixing the underlying code is impossible
or would be worse than suppressing (e.g., a false positive, or a lint that
conflicts with project policy), STOP and ask for permission. Don't waste time on
convoluted workarounds - just ask. When granted, add a comment explaining why
the allow is necessary.

### Dependencies

- Frontend: use bun commands (`bun add`, `bun remove`) inside the flake shell
  (`nix --impure develop -c bash -lc 'cd frontend && bun add <pkg>'`). Never
  manually write version numbers - LLMs hallucinate them.
- Never bypass nix for dependency management.

### When stuck

If a fix doesn't work after three attempts, look up the official documentation.

### No hidden defaults

Never add default values (e.g., `#[serde(default)]`, `Option::unwrap_or`)
without being explicitly asked. Required configuration should fail loudly if
missing, not silently use a value the user didn't choose. Default values can be
grabbed from example.toml if needed. This makes it so that configuration
parameters are explicit by default while at the same time providing an easy
starting point for new setups.

### Testing

Write tests before changing logic. When writing tests for existing code, don't
assume current behavior is correct - it may have bugs.

**Tests must verify both behavior and observability.** Every test that exercises
business logic must also assert on expected log output (via `tracing-test`).
Observability is not optional - if code should log something, the test must
verify it does. Don't create separate test cases for logging; add log assertions
alongside behavioral assertions in the same test.

**Use `logs_contain_at` for log assertions.** The helper
`logs_contain_at(level,
&["snippet1", "snippet2"])` checks that a single log
line at the given level contains all specified snippets. This ensures you're
testing that the right information appears together in one log entry:

```rust
#[traced_test]
#[test]
fn ingestion_logs_progress() {
    // ... trigger ingestion ...
    assert!(logs_contain_at(Level::DEBUG, &["fetching", "BTC"]));
    assert!(logs_contain_at(Level::DEBUG, &["fetched", "1"]));
}
```

---

## Code Style

### Functional programming

Prefer declarative, expression-oriented code:

- `map`, `filter`, `fold`/`reduce`, `collect` over imperative loops
- Pure functions, immutable data
- Immutability by default: in TypeScript use `const`, in Rust use `let`; only
  use `let`/`let mut` respectively when mutation is necessary
- Method chaining over intermediate variables

**The smell to avoid**:
`let mut vec = Vec::new(); for x in xs { vec.push(...) }` when you could just
`.map(...).collect()`. But `mut` is fine in idiomatic contexts like `.scan()`,
`.try_fold()`, or builder patterns (`.with_x()` methods).

### No boolean blindness

Prefer discriminated unions or named functions over raw booleans.

### ASCII for code, Unicode for users

Use ASCII for code, comments, identifiers, logs, commit subjects, PR titles,
configuration, and documentation prose. Preserve Unicode in user-visible product
text and verbatim UI quotations. Do not apply bulk replacements across code or
documentation without distinguishing user-visible strings.

### Self-documenting code

- Documentation comments (docstrings, API docs) are good
- Implementation comments are last resort - refactor to make code clear

### Descriptive names

- Avoid generic names like `result`, `data`, `value`, `item` - name what it IS
- No single-letter variable names anywhere - not in closures, locals,
  parameters, destructuring, or function bindings. `|r|` is unreadable; use
  `|rate|`. `const c = ...` is unreadable; use `const current = ...`. Single
  letters are only acceptable when the user has explicitly approved them for a
  specific case (e.g., conventional loop indices in tight numeric code where a
  longer name would obscure intent).
- No abbreviations unless universally understood (`id`, `url`, `http`, `msg`,
  `tx` are fine). This includes namespace import aliases: `import * as Hl` is
  wrong, use `import * as Hyperliquid`

### Colocate types

Keep types with the code that uses them, not in separate files.

### Logging

Use ERROR for failures that require attention, WARN for unexpected recovered
conditions, INFO for service lifecycle events, DEBUG for operational details,
and TRACE for fine-grained execution. Prefer completion records, unique messages
that identify the subject, and structured fields. Do not duplicate start and
completion messages at the same level, and never log credentials, tokens, or
personal data.

### Data quality verification

When verifying ingested or processed data, follow these checks:

**Structural integrity:**

- Row counts match expectations (compare before/after for incremental loads)
- No duplicate records on primary key (e.g., timestamp + symbol)
- Schema matches expected columns and types
- No null/empty values in required fields

**Temporal validity:**

- Most recent records are current (within expected lag of real-time)
- No gaps in time series where data should be continuous
- Timestamps are in expected format and timezone

**Value reasonableness:**

- Cross-reference key values against external sources (e.g., check BTC price
  against exchange APIs, not against training data or assumptions)
- Numeric values are within plausible ranges for the domain
- No obvious outliers that suggest data corruption (e.g., prices of 0 or
  negative values where impossible)

**Referential integrity:**

- Foreign keys reference valid records
- Symbol/ticker names match expected universe

**Never assume values "look reasonable" without verification.** If you can't
verify against an external source, say "I cannot verify this value" rather than
guessing. Training data cutoffs make historical knowledge unreliable for current
market prices.

### Scripts

Any script large enough to be pulled out into its own file MUST NOT be bash. Use
nushell (`.nu`) instead. Bash is acceptable only for short inline blocks (CI
workflow `run:` steps, npm `scripts`, Makefile recipes); the moment a script
grows into a standalone file, it must be nushell. Shebang: `#!/usr/bin/env nu`.

---

## Rust Code Style

### Package by feature, not by layer

Organize code by business domain, not by language primitives or technical
layers.

**FORBIDDEN file names** (Rust): `types.rs`, `error.rs`, `errors.rs`,
`models.rs`, `utils.rs`, `helpers.rs`, `impl.rs`, `traits.rs`, `structs.rs`,
`enums.rs`, `config.rs`, `constants.rs`, `common.rs`, `shared.rs`, `core.rs`

**FORBIDDEN file names** (TypeScript): `types.ts`, `interfaces.ts`, `utils.ts`,
`helpers.ts`, `constants.ts`, `common.ts`, `shared.ts`

**CORRECT**: `portfolio.rs`, `position.rs`, `rebalancer.rs` (organized by
business domain). Each feature module contains all related code: types, errors,
logic.

When a project is small, put everything in `main.rs` or `lib.rs`. Only split
into modules when there are clear domain boundaries.

### Type modeling

Use enums for finite sets and valid states, and newtypes for domain concepts and
persistent identities. Smart constructors enforce invariants. Parse external
input into these types at the boundary; do not pass raw strings through
application code. Wrap string-based framework identifiers at the boundary.

### Avoid deep nesting

Use early returns and `let-else`. Keep modules shallow and do not nest test
modules. Use descriptive test names. Nested type definitions are appropriate
when they make invalid states unrepresentable.

### Error handling

Use `?` and thiserror to preserve typed error chains. Do not use string-only
error variants or fabricate another crate's errors; define a domain error for a
domain failure. Let compiler feedback identify required conversions. `#[from]`
variant names describe the source error type, not the operation.

### Zero tolerance for panics in non-test code

**FORBIDDEN in production code:**

- `unwrap()`, `expect()`
- `panic!()`, `unreachable!()`, `unimplemented!()`
- Index operations that can panic (`vec[i]`) - use `.get(i)` instead
- Unchecked arithmetic where overflow is possible

**ALLOWED in `#[cfg(test)]` code:** All of the above are fine in tests.

**`todo!()` macro:** Encouraged during TTDD types-first stage to stub
signatures. Must be removed before completion - any `todo!()` in final code is
unacceptable.

### Module organization

Public API first, private helpers below.

### Minimal visibility

Always use the most restrictive visibility possible:

- Private (default) over `pub(super)`
- `pub(super)` over `pub(crate)`
- `pub(crate)` over `pub`

### Import organization

Two groups only:

1. External imports (`std`, `tokio`, `serde`, etc.)
2. Internal imports (`crate::`, `super::`)

Blank line between groups. No function-level imports.

Use qualified paths instead of aliases to resolve import name conflicts. Import
tracing macros and invoke them unqualified.

### Spacing

Leave empty lines between code blocks for readability and vim navigation.

---

## Testing

### Testing pyramid

Follow the pyramid - more tests at lower levels, fewer at higher:

1. **Property tests** - Most numerous. Use proptest for invariant testing
2. **Unit tests** - Exhaustive edge cases, fast feedback
3. **Integration tests** - Components working together, mocked externals
4. **E2E tests** - Fewest, but essential for full system orchestration

The pyramid is about quantity, not avoidance. You should have MANY property/unit
tests, SOME integration tests, and a FEW e2e tests. But e2e tests are still
required when testing full system orchestration.

**When e2e tests ARE required:**

- Testing that multiple async processes coordinate correctly
- Testing startup/shutdown behavior and recovery
- Testing flows that span multiple components AND external systems
- Testing that the service handles events that occurred before it started

A single well-designed e2e test can cover orchestration, while dozens of unit
tests cover edge cases in each component.

### E2E tests: strict definition

E2E tests live in `./tests/`, not in `src/`.

A test is ONLY e2e if it:

1. Spins up the full HTTP service
2. Uses ONLY the public API as an external consumer would
3. Mocks only truly external systems
4. Asserts correctness via API responses

A test is NOT e2e if it touches implementation details for setup or
verification. If a test requires internal types, it belongs in `src/` as a unit
or integration test.

### Testing guidelines

- Tests must assert CORRECT behavior, never "document gaps"
- Add context to failing `assert!` macros instead of `println!` debugging
- Never test language features - test business logic
- Only cover happy paths in integration/e2e tests; cover edge cases in unit
  tests

**Hands-off: `src/factors/fixture_tests.rs`.** Do not edit this file unless the
user gives a direct, explicit instruction to do so. These tests pin expected
factor values calculated by hand in Google Sheets; they are the source of truth
for factor semantics. When a fixture test fails, fix the production code (or
update `data_test/` only when the user supplies corrected spreadsheet values) --
never relax tolerances, rewrite assertions, or delete cases to make broken code
pass.

Reproduce bugs through the actual code paths and realistic fixtures. Assert
correct behavior rather than language mechanics or known defects.

---

## shadcn-solid

Never manually create component files. Use the CLI:

```bash
cd frontend && bunx shadcn-solid@latest add <component-name>
```

### Avoid createEffect

Before adding `createEffect`, consider: `@tanstack/solid-query` for data
fetching, `createMemo` for derived state. When `createEffect` IS required
(imperative DOM manipulation, side-effects on signal changes, global event
listeners), add an inline comment explaining why.

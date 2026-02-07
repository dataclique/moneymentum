# AGENTS.md

Guidance for AI agents working in this repository.

---

## Project Direction

This project is transitioning from a Python-based momentum trading bot to an
institutional-grade quant toolkit. See [SPEC.md](./SPEC.md) for the vision and
[ROADMAP.md](./ROADMAP.md) for the path.

**Current state:**

- Frontend at `/` is a working portfolio rebalancer (weight-based positions,
  cross-account leverage). Used daily.
- Frontend at `/prototype` is a design reference (like Figma in code).
- Python backend (`yang/`, `pipeline.py`, `server.py`) exists but is being
  replaced by a Rust backend.

**What's being built:**

- Rust backend for analytics and API (polars, cqrs-es, rocket)
- First priority: portfolio beta calculation (current tool shows net notional,
  which ignores correlations and makes hedging guesswork)

**Key architectural decisions:**

- **All Rust**: Official SDKs for Hyperliquid, Derive, deBridge, Jupiter. Polars
  for analytics. Single language from API to blockchain interactions.
- **Frontend holds credentials**: Backend generates execution plans, frontend
  executes. Credentials never leave the browser.
- **Portfolios as proportions**: Target portfolios are defined as weights +
  leverage, not dollar amounts. Rebalancing = return to target proportions.

---

## Development Commands

### Frontend (React + Vite)

Run from `frontend/` directory:

```bash
cd frontend
bun run typecheck  # Type check only
bun run lint       # Lint
bun run test       # Run tests (vitest)
bun run build      # Full build
bun run dev        # Dev server (port 5173) - only when explicitly asked
```

### Backend (Rust)

```bash
cargo check              # Fast compilation verification
cargo test -q            # Run tests
cargo clippy             # Linting
cargo fmt                # Format code
```

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
Cargo.toml versions.

### Legacy Python (still functional, being replaced)

```bash
python server.py   # FastAPI server on port 8000
python backtest.py # Generate analysis CSV
pytest             # Run tests
ruff check .       # Lint
ruff format .      # Format
```

### Environment

- **Nix + Direnv**: `direnv allow` activates the dev environment
- All dependencies managed through Nix flake - do not use pip install, bun
  install, or similar

---

## Agent Rules

### When issues are pointed out

Fix immediately. The user never sends messages just for the sake of it.

### No self-promotion

Never add "Generated with [Tool Name]" to commits, PRs, or code.

### PR descriptions

Explain WHY the PR exists, not what changed.

### Quality checks

Never disable or relax lints, type checks, tests, or pre-commit hooks without
explicit approval. Fix the underlying issue.

### Dependencies

- Frontend: use bun commands (`bun add`, `bun remove`). Never manually write
  version numbers - LLMs hallucinate them.
- Never bypass nix for dependency management.

### When stuck

If a fix doesn't work after three attempts, look up the official documentation.

### Testing

Write tests before changing logic. When writing tests for existing code, don't
assume current behavior is correct - it may have bugs.

---

## Code Style

### Functional programming

- Prefer `map`, `filter`, `reduce` over imperative loops
- Pure functions, immutable data
- `const` by default, `let` only when necessary

### No boolean blindness

Prefer discriminated unions or named functions over raw booleans:

```typescript
// Bad
setIsOpen(true);

// Good
type ModalState = "open" | "closed";
setModalState("open");

// Also good
const openModal = () => setIsOpen(true);
```

### Self-documenting code

- Documentation comments (docstrings, API docs) are good
- Implementation comments are last resort - refactor to make code clear

### No `types.ts` files

Colocate types with the code that uses them.

### Avoid useEffect

Before adding `useEffect`, consider: TanStack Query for data fetching,
`use-local-storage-state` for localStorage, `useMemo` for derived state. When
useEffect IS right, add a comment explaining why.

---

## Rust Code Style

### Package by feature, not by layer

**FORBIDDEN**: `types.rs`, `error.rs`, `models.rs`, `utils.rs`, `helpers.rs`

**CORRECT**: `portfolio.rs`, `position.rs`, `rebalancer.rs` (organized by
business domain). Each feature module contains all related code: types, errors,
logic.

### Type modeling

**Make invalid states unrepresentable.** Use enums to encode valid states,
newtypes for domain concepts:

```rust
// Bad: fields can contradict each other
struct Order { status: String, order_id: Option<String>, error: Option<String> }

// Good: each state has exactly the data it needs
enum OrderStatus {
    Pending,
    Completed { order_id: String },
    Failed { reason: String },
}
```

**Parse, don't validate.** If a value exists, it must be valid. Validation
happens at construction through smart constructors:

```rust
// Bad: validation can be forgotten
pub struct ApiKey(pub String);
impl ApiKey { pub fn validate(&self) -> Result<(), Error> { ... } }

// Good: if ApiKey exists, it's valid
pub struct ApiKey(String);  // Private inner
impl ApiKey {
    pub fn new(value: String) -> Result<Self, Error> { ... }  // Only way to create
}
```

### Avoid deep nesting

Use early returns and `let-else` for flat code:

```rust
fn validate(d: Option<&Data>) -> Result<(), Error> {
    let d = d.ok_or(Error::NoData)?;
    if d.qty <= 0 { return Err(Error::InvalidQty); }
    Ok(())
}
```

### Error handling

- Use `?` operator and proper error types
- Never create `SomeError(String)` variants that throw away type information
- Use `#[from]` with thiserror to preserve error chains

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

Public API first, private helpers below. Keep visibility as restrictive as
possible (`pub(crate)` over `pub`, private over `pub(crate)`).

### Import organization

Two groups only:

1. External imports (`std`, `tokio`, `serde`, etc.)
2. Internal imports (`crate::`, `super::`)

Blank line between groups. No function-level imports.

### Spacing

Leave empty lines between code blocks for readability and vim navigation.

### Quality control policy

**NEVER disable or relax any quality checks without explicit permission.** This
applies to:

- Clippy lints (`#[allow(clippy::*)]`)
- Compiler warnings (`#[allow(dead_code)]`, `#[allow(unused)]`)
- All linters in all languages (eslint, ruff, etc.)
- Test coverage - should not decrease without permission

Fix the underlying code, don't suppress warnings.

---

## Testing

### Testing pyramid

Follow the pyramid - more tests at lower levels, fewer at higher:

1. **Property tests** - Most numerous. Use proptest for invariant testing
2. **Unit tests** - Exhaustive edge cases, fast feedback
3. **Integration tests** - Components working together, mocked externals
4. **E2E tests** - Fewest, but essential for full system orchestration

### Testing guidelines

- Tests must assert CORRECT behavior, never "document gaps"
- Add context to failing `assert!` macros instead of `println!` debugging
- Never test language features - test business logic
- Only cover happy paths in integration/e2e tests; cover edge cases in unit
  tests

---

## shadcn/ui

Never manually create component files. Use the CLI:

```bash
cd frontend && bunx shadcn@latest add <component-name>
```

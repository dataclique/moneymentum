# AGENTS.md

Rules and guidelines for AI agents working in this repository. Everything in
this document is a directive, not a suggestion.

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

### Frontend (SolidJS + Vite)

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

**Migrations**: Never manually create migration files. Always use sqlx CLI:

```bash
sqlx migrate add <migration_name>  # Creates timestamped migration file
sqlx migrate run                   # Applies pending migrations
```

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

## Workflow & Policies

### When issues are pointed out

Fix immediately. The user never sends messages just for the sake of it.

### No self-promotion

Never add "Generated with [Tool Name]" to commits, PRs, or code.

### PR descriptions

Explain WHY the PR exists, not what changed.

### Quality checks

**NEVER disable or relax any quality checks without explicit permission.** This
applies to:

- Clippy lints (`#[allow(clippy::*)]`)
- Compiler warnings (`#[allow(dead_code)]`, `#[allow(unused)]`)
- All linters in all languages (eslint, ruff, etc.)
- Test coverage - should not decrease without permission

Fix the underlying code, don't suppress warnings.

**When permission IS appropriate:** If fixing the underlying code is impossible
or would be worse than suppressing (e.g., a false positive, or a lint that
conflicts with project policy), STOP and ask for permission. Don't waste time on
convoluted workarounds - just ask. When granted, add a comment explaining why
the allow is necessary.

### Dependencies

- Frontend: use bun commands (`bun add`, `bun remove`). Never manually write
  version numbers - LLMs hallucinate them.
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

### ASCII-only code

All code, comments, identifiers, and documentation must use ASCII characters
only. Unicode is allowed exclusively in string literals that produce
user-visible output (UI text, CLI messages). Use ASCII equivalents in comments:
`*` not `×`, `->` not `→`, `~` not `≈`, `--` not `—`, `beta` not `β`.

### Self-documenting code

- Documentation comments (docstrings, API docs) are good
- Implementation comments are last resort - refactor to make code clear

### Descriptive names

- Avoid generic names like `result`, `data`, `value`, `item` - name what it IS
- **No single-letter variable or parameter names anywhere**: `c` is unreadable,
  use `client`. `r` is unreadable, use `rate`. This applies to function
  parameters, arrow function args, local variables, destructured bindings, and
  loop variables. The only exception is `_` for intentionally unused values
- No abbreviations unless universally understood (`id`, `url`, `http`, `msg`,
  `tx` are fine). This includes namespace import aliases: `import * as Hl` is
  wrong, use `import * as Hyperliquid`

### Colocate types

Keep types with the code that uses them, not in separate files.

### Logging

Use log levels semantically:

- **ERROR**: Something failed that requires attention (unrecoverable failures,
  unexpected exceptions)
- **WARN**: Something unexpected happened but the system recovered (retries
  exhausted, fallback used, deprecated feature accessed)
- **INFO**: High-level service lifecycle events only (service ready, graceful
  shutdown). One or two lines per service startup, not per component
- **DEBUG**: Operational details useful for troubleshooting (component
  initialized, request handled, configuration applied)
- **TRACE**: Fine-grained execution flow for deep debugging (variable values,
  loop iterations, function entry/exit)

**Message quality:**

- Log when something completes, not when it starts. "hyperliquid client ready"
  not "initializing hyperliquid client"
- Messages should be grep-friendly and unique. Avoid generic "error occurred" or
  "operation failed"
- Include relevant context as structured fields, not interpolated strings:
  `info!(port = config.port, "server ready")` not
  `info!("server ready on port
  {}", config.port)`
- Use past tense or state descriptions: "request processed", "connection
  established", "cache invalidated"

**Anti-patterns:**

- Logging both "starting X" and "X complete" at the same level - pick one
  (prefer completion)
- INFO-level logs for internal component setup (use DEBUG)
- Logging sensitive data (credentials, tokens, PII)
- Empty or near-empty messages: `debug!("here")`, `info!("")`
- Vague messages without subject: `info!("initialized")` - initialized what?
  Yes, tracing adds module prefixes, but logs should be clear at a glance
  without parsing `moneymentum::hyperliquid::client`. Say
  `debug!("hyperliquid client
  ready")` instead

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

**Make invalid states unrepresentable.** This is non-negotiable. Every type must
constrain its values to only valid states.

**Never use String when the domain has a finite set of valid values:**

```rust
// FORBIDDEN: String accepts infinite invalid values
struct Config { log_level: String }  // "info", "debug", but also "banana", ""

// CORRECT: enum restricts to valid values only
enum LogLevel { Trace, Debug, Info, Warn, Error }
struct Config { log_level: LogLevel }
```

**Use enums to encode valid states, newtypes for domain concepts:**

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

**When deserializing from external sources** (config files, API requests), parse
into proper types immediately at the boundary. Never pass raw strings through
the system.

**Aggregate IDs must be newtypes.** Never use raw `String` or `&str` for
aggregate identifiers. cqrs-es uses stringly-typed IDs, but we wrap them:

```rust
// Bad: easy to mix up different aggregate IDs (banned by clippy)
cqrs.execute("perp:hyperliquid", command).await;
cqrs.execute("user:123", command).await;  // Oops, wrong ID type

// Good: type system prevents mixing IDs
struct IngestionId;
impl AggregateId<Ingestion> for IngestionId {
    type Args = ();
    fn aggregate_id((): ()) -> String { "perp:hyperliquid".into() }
}
// Use typed execute: cqrs.execute::<IngestionId>((), command)
```

Use `wire::AggregateId` trait and `wire::Cqrs::execute` for type-safe ID
construction. The stringly-typed version is banned via clippy.

### Avoid deep nesting

Keep code flat in function bodies, module structure, and test organization.

**Function bodies**: Use early returns and `let-else`:

```rust
fn validate(data: Option<&Data>) -> Result<(), Error> {
    let data = data.ok_or(Error::NoData)?;
    if data.qty <= 0 { return Err(Error::InvalidQty); }
    Ok(())
}
```

**Modules**: Don't nest modules inside modules. Keep hierarchy shallow.

**Tests**: No nested modules inside `mod tests`. Use descriptive function names:

```rust
// Bad
mod tests { mod symbol { fn normalizes() { ... } } }

// Good
mod tests { fn symbol_normalizes_hyperliquid_format() { ... } }
```

**Exception - types**: Nesting in type definitions is fine when it makes invalid
states unrepresentable. An enum with struct variants is better than flattening
into mutually exclusive optional fields.

### Error handling

- Use `?` operator and proper error types
- Never create `SomeError(String)` variants that throw away type information
- Use `#[from]` with thiserror to preserve error chains
- Don't think ahead about error variants - use `?` wherever needed, then
  `cargo check` tells you exactly which `#[from]` variants to add

**Never fabricate errors from other crates.** If you need to signal a condition,
define your own error type. Manually constructing `std::io::Error::new(...)` or
similar is data corruption - it lies about the error's origin and misleads
anyone debugging:

```rust
// FORBIDDEN: pretending std::io produced this error
Err(std::io::Error::new(ErrorKind::InvalidInput, "bad path"))

// CORRECT: define your own error variant
#[derive(Debug, Error)]
enum MyError {
    #[error("invalid path encoding")]
    InvalidPathEncoding,
}
```

**`#[from]` variant naming**: When using thiserror's `#[from]` attribute,
variant names must be generic (matching the source error type) and MUST NOT
claim what operation failed. The `?` operator auto-converts any matching error
type to the variant, so specific claims become false if another operation
produces the same error type.

- **FORBIDDEN**: `ReadConfig(#[from] std::io::Error)` - claims config reading
  failed, but any `?` on io::Error will use this variant
- **CORRECT**: `Io(#[from] std::io::Error)` - generic, makes no false claims
- **FORBIDDEN**: `ParseConfig(#[from] toml::de::Error)` - claims config parsing
- **CORRECT**: `Toml(#[from] toml::de::Error)` - generic, truthful

Rule: If `#[from]` is used, the variant name should mirror the error type, not
the operation.

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

This enables robust dead code detection by the compiler. When something is
`pub`, the compiler can't know if external code uses it, so it won't warn about
unused items. Restrictive visibility makes the relevance scope explicit and lets
tooling catch unused code.

### Import organization

Two groups only:

1. External imports (`std`, `tokio`, `serde`, etc.)
2. Internal imports (`crate::`, `super::`)

Blank line between groups. No function-level imports.

**No import aliases for name conflicts.** When two types have the same name, use
qualified paths instead of `as` aliases. Aliases require jumping around to
figure out what's what:

```rust
// Bad: reader must find the alias to understand the code
use crate::ingestion::Timeframe as IngestionTimeframe;

// Good: meaning is clear at the usage site
impl From<Timeframe> for crate::ingestion::Timeframe { ... }
```

**Tracing macros are unqualified.** We use tracing and nothing else for logging,
so `tracing::error!` qualification adds no disambiguation value - it's just
verbose bloat:

```rust
// Bad: verbose, no added clarity
tracing::error!(error = %err, "failed");

// Good
use tracing::error;
error!(error = %err, "failed");
```

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

**Bug reproduction must exercise real code paths.** When reproducing a bug:

```rust
// BAD: Manually constructs incompatible DataFrames - proves nothing
let existing = df! { "a" => [1], "b" => [2], "extra" => [3] }.unwrap();
let new = df! { "a" => [1], "b" => [2] }.unwrap();
merge_and_deduplicate(Some(existing), new); // Obviously fails

// GOOD: Uses actual code paths with realistic fixtures
let existing = read_csv(fixture_path("legacy_ohlcv.csv")).await?; // 8 columns
let candles = vec![Candle { ... }]; // Real domain objects
let new = candles_to_dataframe(candles).await?; // 7 columns from real code
merge_and_deduplicate(existing, new); // Proves the actual bug
```

The first test shows that incompatible things are incompatible. The second
proves the system produces incompatible things - that's the bug.

```rust
// Bad: tests struct assignment, not our code
fn test_fields() {
    let request = Request { qty: 100, symbol: "AAPL".into() };
    assert_eq!(request.qty, 100);
}

// Good: tests our validation logic
fn test_validates_quantity() {
    let result = validate_order(OrderRequest { qty: -10, symbol: "AAPL".into() });
    assert!(matches!(result, Err(OrderError::InvalidQuantity)));
}
```

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

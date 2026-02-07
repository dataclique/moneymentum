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

### Backend (Rust - being built)

TBD - see ROADMAP.md Phase 1 for infrastructure setup.

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

## shadcn/ui

Never manually create component files. Use the CLI:

```bash
cd frontend && bunx shadcn@latest add <component-name>
```

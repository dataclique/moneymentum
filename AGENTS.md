# AGENTS.md

This file provides guidance to AI agents when working with code in this
repository.

## Common Development Commands

### Python Backend

- **Run live trading pipeline**: `python pipeline.py`
- **Run backtest**: `python backtest.py` (generates `data/analysis_df.csv`)
- **Run API server**: `python server.py` (FastAPI server on port 8000)
- **Lint Python code**: `ruff check .`
- **Format Python code**: `ruff format .`
- **Run tests**: `pytest`
- **Type checking**: `mypy yang/` (disabled by default in flake.nix)
- **Pre-commit checks**: `pre-commit run -a` (must pass before completing tasks;
  run twice for formatting issues)

### Frontend (React + Vite)

- **Development server**: `bun --cwd frontend run dev` (port 5173)
- **Build frontend**: `bun --cwd frontend run build`
- **Lint frontend**: `bun --cwd frontend run lint`
- **Run tests**: `bun --cwd frontend run test` (uses vitest)
- **Preview build**: `bun --cwd frontend run preview`
- **Serve production build**: `bun --cwd frontend run serve:spa`

### Environment Setup

- **Nix + Direnv**: Run `direnv allow` to activate the development environment
- **Python dependencies**: The nix flake automatically installs all pip
  dependencies from `requirements.txt` when entering the dev shell. Do not run
  `pip install` manually.
- **Frontend dependencies**: The nix flake automatically runs `bun install` in
  the frontend directory when entering the dev shell. Do not run `bun install`
  manually.

## Architecture Overview

### Core Trading System Components

The system implements a momentum-based trading strategy for cryptocurrency
perpetual futures on Hyperliquid exchange:

**Chronos Engine** (`yang/chronos.py`): Time series analysis engine using
PySpark that calculates:

- Log returns and cumulative returns over rolling windows
- Volatility (standard deviation and annualized volatility)
- Autocorrelation for momentum detection
- Simple Moving Averages (SMA) and z-scores
- Beta coefficient relative to market
- Sharpe and Sortino ratios
- Information discreteness metrics

**Strategy** (`yang/strat.py`): Trading signal generation orchestrating Chronos
analysis pipeline

- `generate_analysis()`: Applies all Chronos transformations to OHLCV data
- `generate_picks()`: Generates long/short positions based on predicted returns
  combining autocorrelation and SMA signals
- Position sizing based on beta-adjusted weights and leverage constraints

**Execution Engine** (`yang/exe.py`): Trade execution and portfolio management
via CCXT

- Fetches current positions and balance from Hyperliquid
- `rebalance()`: Reconciles target portfolio with current positions
- Handles order placement with retry logic and rate limiting

**Pipeline Orchestration**:

- `pipeline.py`: Live trading loop that continuously runs analysis and
  rebalances
- `backtest.py`: Historical backtesting that saves analysis results to CSV
- `server.py`: FastAPI server exposing analysis data to frontend with
  streaming backtest execution

### Data Loading

**HyperliquidDataLoader** (`yang/dataloader/hyperliquid/`):

- `ohlcv.py`: Fetches OHLCV candle data for multiple timeframes
- `funding_rates.py`: Retrieves funding rate data
- `markets.py`: Gets market information and filters tradeable assets
- Async context manager pattern for resource management

### Frontend Architecture

React + TypeScript SPA with:

- **TokenPage** (`frontend/src/pages/TokenPage/`): Main analysis dashboard
- **ChartComponent**: Interactive price charts using LightweightCharts library
- **Data tables**: Sortable/filterable tables with TanStack React Table
- **Theme**: Dark/light mode support with next-themes and Radix UI
- **Styling**: TailwindCSS 4 with Radix UI primitives

### Key Data Flow

1. `pipeline.py` or `backtest.py` orchestrates the trading pipeline
2. `HyperliquidDataLoader` fetches OHLCV and market data asynchronously
3. `Chronos` engine transforms raw candles into analysis DataFrame using
   PySpark
4. `Strategy.generate_picks()` produces position targets with weights
5. `ExecutionEngine.rebalance()` executes trades (pipeline.py only)
6. `backtest.py` saves analysis to `data/analysis_df.csv`
7. Frontend fetches data from FastAPI server and displays interactive charts

### Technology Stack

- **Backend**: Python 3.11, PySpark, FastAPI, Pandas, CCXT, asyncio
- **Frontend**: React 19, TypeScript, Vite, TailwindCSS 4, Radix UI,
  LightweightCharts, TanStack Table
- **Development**: Nix flakes with devenv for reproducible environment
- **Code Quality**: Ruff (extensive ruleset in ruff.toml), Prettier
  (frontend), pre-commit hooks

## Development Environment

Uses Nix flakes with devenv configured in `flake.nix`:

- Python 3.11 with venv and automatic dependency installation from
  requirements.txt
- Bun for frontend development (JavaScript runtime and package manager)
- Java 17 and native libraries for PySpark (zlib, libffi, gcc)
- Pre-commit hooks: ruff, ruff-format, prettier, nixfmt-classic
- Environment variables: `JAVA_HOME`, `LD_LIBRARY_PATH` set automatically

## Configuration

**Timeframes** (`yang/util.py`): Configured in `TIMEFRAME_CONFIGS` dict with:

- Lookback periods for rolling windows
- Number of tokens to trade
- Annualization factors for volatility/Sharpe calculations

**Ruff**: Comprehensive linting with ~40 rule categories enabled in
`ruff.toml`, line length 100

**Prettier**: Configured in `frontend/package.json` with tabWidth 2, no
semicolons

## Agent Rules

### When issues are pointed out

When the user points out an issue, bug, or problem - fix it immediately. Do not
ask "Want me to fix this?" or "Should I address this?". The user never sends
messages just for the sake of it; when they point out issues, they expect action
(usually a fix, sometimes reproducing, opening a GitHub issue, etc. based on
context).

### No self-promotion

Never add "Generated with [Tool Name]" or similar attribution to commits, PRs,
or code.

### PR descriptions

Explain WHY the PR exists, not what changed. The diff shows what changed.

**IMPORTANT**: Never disable or relax any quality checks (lints, type checks,
tests, pre-commit hooks, etc.) without explicitly asking the user first. Always
fix the underlying issue rather than suppressing the warning/error.

**IMPORTANT**: Never manually write version numbers for frontend dependencies.
Always use bun commands (`bun add`, `bun remove`, etc.) to manage dependencies.
LLMs hallucinate version numbers.

**IMPORTANT**: Never bypass nix for dependency management in CI or development.
All dependencies must be managed through the nix flake to ensure consistency
across all environments. Do not use setup-bun, setup-node, pip install, or
similar actions that bypass nix.

**IMPORTANT**: If a fix doesn't work after three attempts, stop and look up the
official documentation. Do not keep trying random variations.

**IMPORTANT**: Write tests before changing any logic. When modifying existing
code or adding new features, first write tests that define the expected behavior,
then implement the changes to make those tests pass.

## shadcn/ui Components

**IMPORTANT**: Never manually create shadcn component files. Always use the CLI:

```bash
cd frontend && bunx shadcn@latest add <component-name>
```

This ensures components are properly configured with the project's theme and
dependencies.

## Code Style Anti-Patterns

The following patterns are **NOT ALLOWED** in this codebase:

### No `types.ts` files

Do not create separate `types.ts` files. Types should be colocated with the code
that uses them. If a type is used by multiple files, export it from the primary
file that defines the concept.

### Prefer descriptive names over abbreviations

Default to descriptive names rather than abbreviations. Well-established
abbreviations like `msg`, `ctx`, `err`, `req`, `res` are acceptable when their
meaning is clear from context, but full names should be the default choice.

Avoid project-specific or non-standard abbreviations:

- `cn` → `mergeClassNames` (not a well-known abbreviation)
- `btn` → `button` (prefer full word in most cases)

### Self-Documenting Code Over Comments

Code must be self-explaining through good names and clean architecture.

- **Documentation comments are good**: Explain what something does and how to
  use it (docstrings, API docs, README sections)
- **Implementation comments are a last resort**: Comments explaining how code
  works should only be used when the code cannot be made clear by improving the
  code itself (better names, smaller functions, clearer structure)

If you find yourself writing a comment to explain complex logic, first try to
refactor the code to be self-explanatory.

### Avoid Boolean Blindness

Raw booleans obscure meaning at call sites. When you see `doThing(true)`, what
does `true` mean? You have to look at the function signature to understand.

**Prefer discriminated unions over booleans:**

```typescript
// Bad - boolean blindness
const [isOpen, setIsOpen] = useState(false);
setIsOpen(true); // What does true mean here?
setIsOpen(false);

// Good - explicit state
type ModalState = "open" | "closed";
const [modalState, setModalState] = useState<ModalState>("closed");
setModalState("open");
setModalState("closed");

// Also good - named functions wrapping the boolean
const [isOpen, setIsOpen] = useState(false);
const openModal = () => setIsOpen(true);
const closeModal = () => setIsOpen(false);
const toggleModal = () => setIsOpen((prev) => !prev);
// Usage: openModal(), closeModal(), toggleModal()
```

This applies especially to:

- UI state (open/closed, expanded/collapsed, visible/hidden)
- Function parameters that are booleans
- Toggle operations

### Prefer Functional Programming

Avoid mutability and always prefer FP when there are options to choose from:

- **Immutable data**: Use spread operators, `map`, `filter`, `reduce` instead of
  mutating arrays/objects
- **Pure functions**: Prefer functions without side effects
- **No `let` when `const` works**: Use `const` by default, `let` only when
  reassignment is truly necessary
- **Declarative over imperative**: Prefer `array.map()` over `for` loops,
  `array.filter()` over manual filtering
- **Avoid mutation methods**: Use `[...arr, item]` instead of `arr.push(item)`,
  `{ ...obj, key: value }` instead of `obj.key = value`
- **Build collections declaratively**: Use filter/map chains instead of loops
  that mutate a collection

```typescript
// Bad - imperative with mutation
const collapsed = new Set<string>();
for (const group of groups) {
  if (group.items.length === 1) {
    collapsed.add(group.id);
  }
}

// Good - declarative with filter/map
new Set(
  groups.filter((group) => group.items.length === 1).map((group) => group.id),
);
```

### Avoid useEffect When Better Alternatives Exist

Before adding `useEffect`, always consider whether there's a better alternative:

- **Data fetching**: Use TanStack Query (`@tanstack/react-query`) instead of
  `useEffect` + `fetch` + loading/error state
- **Local storage**: Use `use-local-storage-state` instead of manual
  `useEffect` + `localStorage.getItem/setItem`
- **Derived state**: Use `useMemo` instead of `useEffect` + `setState` to
  compute values from other state
- **Event listeners**: Consider if the event can be handled declaratively in JSX
  (`onClick`, `onKeyDown`) before using `useEffect` for global listeners
- **Subscriptions**: Use libraries designed for the specific subscription type
  (WebSocket libraries, RxJS, etc.)
- **Refs for DOM measurement**: Use `ResizeObserver` via a dedicated hook or
  library rather than raw `useEffect`

`useEffect` is appropriate for:

- Synchronizing with external systems that have no React-specific library
- Global keyboard shortcuts that can't be handled by focused elements
- Chart libraries that need imperative DOM manipulation

**When useEffect IS the right tool, add a comment explaining why:**

```typescript
// useEffect justified: LightweightCharts requires imperative DOM manipulation
// and has no React wrapper. No better alternative exists.
useEffect(() => {
  const chart = createChart(container, options);
  // ...
}, []);
```

This requirement exists because useEffect has many footguns (stale closures,
missing dependencies, race conditions). Requiring justification ensures
developers have considered alternatives before reaching for useEffect.

### Test-Driven Development

When writing tests for existing code, do NOT assume the current behavior is
correct. The code may have bugs. Ask the user if you're unsure whether a
behavior is intentional or a bug.

## Testing

- Python tests in `tests/` directory
- Run with `pytest` command
- Test data available in `test_data/` directory
- Main test file: `tests/test_chronos.py`

## Data Files

- `data/`: Production data files (`analysis_df.csv`, `funding_rate1h.csv`,
  `ohlcv15m.csv`)
- `test_data/`: Test datasets for development
- Pipeline logs written to `pipeline.log`

# Moneymentum

[![His name is Yang](https://img.youtube.com/vi/FoYC_8cutb0/0.jpg)](https://www.youtube.com/watch?v=FoYC_8cutb0)

A factor-based portfolio management toolkit for DeFi trading. Think in terms of exposures (beta, momentum, carry) rather than individual positions.

See [SPEC.md](./SPEC.md) for the vision and [ROADMAP.md](./ROADMAP.md) for the path there.

---

## What Works Today

**Portfolio Rebalancer** (`/`): Set positions by weight, adjust cross-account leverage while maintaining proportions. Currently shows net notional exposure; beta-aware hedging coming soon.

**Design Reference** (`/prototype`): Interactive mockup of the target UI/UX.

---

## Architecture

| Layer          | Technology             | Status         |
| -------------- | ---------------------- | -------------- |
| Frontend       | TypeScript + React     | Active         |
| Backend        | Scala 2 + Spark + cats | Building       |
| Legacy Backend | Python + PySpark       | Being replaced |

The frontend holds credentials and executes trades directly to venues. The backend provides analytics and execution plans but never touches credentials.

---

## Getting Started

### Prerequisites

- Nix with flakes enabled
- Direnv (recommended)

### Setup

```bash
git clone https://github.com/data-cartel/moneymentum.git
cd moneymentum
direnv allow  # or: nix develop
```

### Run Frontend

```bash
cd frontend
bun run dev  # http://localhost:5173
```

### Run Legacy Backend (Python)

```bash
python server.py  # FastAPI on port 8000
```

---

## Development

```bash
# Frontend (from frontend/)
bun run typecheck
bun run lint
bun run test

# Legacy Python
ruff check .
ruff format .
pytest

# Pre-commit (must pass)
pre-commit run -a
```

All dependencies managed through Nix. Do not use pip install or bun install directly.

---

## License

See repository for license information.

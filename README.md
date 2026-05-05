# Moneymentum

[![His name is Yang](https://img.youtube.com/vi/FoYC_8cutb0/0.jpg)](https://www.youtube.com/watch?v=FoYC_8cutb0)

Moneymentum is an institutional-grade quant toolkit for crypto portfolio
management. Define portfolios as proportions, not positions. Stage and simulate
before executing. Manage factor exposures, not symbols. Most crypto holders
cannot answer basic questions about their portfolio's factor exposure;
Moneymentum makes those exposures legible and adjustable.

## Status

- **Frontend rebalancer** (working, used daily): weight-based positions,
  cross-account leverage, staged trade preview, execution against Hyperliquid
  perps.
- **Frontend prototype** at `/prototype`: design reference for the target UI.
- **Backend** (active development): Rust + Rocket API, Polars analytics, cqrs-es
  event store on SQLite. Ingests Hyperliquid OHLCV and funding rates; computes
  rolling beta to BTC.
- **Vault program** (planned): Anchor program on Solana for non-custodial
  managed deposits with two-phase withdrawal.

See [ROADMAP.md](./ROADMAP.md) for what's next.

## Documentation

| Doc                                       | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| [SPEC.md](./SPEC.md)                      | Product vision and target architecture            |
| [ROADMAP.md](./ROADMAP.md)                | Themed user stories ordered by priority           |
| [user-stories/](./user-stories/README.md) | Customer-visible work units with acceptance tests |
| [contributions.md](./contributions.md)    | XP workflow for contributors                      |
| [AGENTS.md](./AGENTS.md)                  | Per-repo rules for AI coding agents               |

## Quick start

### Prerequisites

- Nix with flakes enabled
- Direnv (recommended)

### Setup

```bash
git clone https://github.com/data-cartel/moneymentum.git
cd moneymentum
direnv allow  # or: nix develop
```

### Frontend

Run from `frontend/`:

```bash
bun run typecheck   # type check
bun run lint        # eslint
bun run test        # vitest
bun run dev         # dev server on :5173
bun run build       # production bundle
```

### Backend

Run from repo root:

```bash
cargo check         # fast compilation verification
cargo test -q       # tests
cargo clippy        # lints (pedantic + nursery, panic-free)
cargo fmt           # format

cargo run -- --help # see CLI options
```

Configuration is loaded from a TOML file modeled on
[example.toml](./example.toml).

### Pre-commit

```bash
pre-commit run -a
```

All dependencies are managed through Nix. Do not use `bun install` or similar
directly.

### Running AI coding agents

Launch agents via `nix develop --impure` rather than relying on direnv to avoid
shell-init quirks:

```bash
nix develop --impure -c claude
```

Agents must follow [AGENTS.md](./AGENTS.md).

## Infrastructure

Terraform provisions the server, then NixOS is bootstrapped onto it.

```bash
nix run .#tfCreateVars   # create + encrypt terraform vars
nix run .#tfInit
nix run .#tfPlan
nix run .#tfApply
nix run .#bootstrap      # bootstrap NixOS

nix run .#remote         # SSH
nix run .#tfEditVars
nix run .#tfDestroy
```

Infrastructure commands use age-encrypted state. The `-i` flag selects a custom
SSH identity (defaults to `~/.ssh/id_ed25519`).

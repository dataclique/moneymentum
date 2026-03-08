# Moneymentum

[![His name is Yang](https://img.youtube.com/vi/FoYC_8cutb0/0.jpg)](https://www.youtube.com/watch?v=FoYC_8cutb0)

A factor-based portfolio management toolkit for DeFi trading. Think in terms of
exposures (beta, momentum, carry) rather than individual positions.

See [SPEC.md](./SPEC.md) for the vision and [ROADMAP.md](./ROADMAP.md) for the
path there.

---

## What Works Today

**Portfolio Rebalancer** (`/`): Set positions by weight, adjust cross-account
leverage while maintaining proportions. Displays portfolio beta (BTC
correlation) and funding rates alongside positions.

**Design Reference** (`/prototype`): Interactive mockup of the target UI/UX.

---

## Architecture

| Layer    | Technology                  | Status |
| -------- | --------------------------- | ------ |
| Frontend | TypeScript + SolidJS (Vite) | Active |
| Backend  | Rust (Rocket, Polars)       | Active |

The frontend holds credentials and executes trades directly to venues. The
backend provides analytics and execution plans but never touches credentials.

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

### Run Backend

```bash
cargo run  # Rust backend on port 8000
```

---

## Development

```bash
# Frontend (from frontend/)
bun run typecheck
bun run lint
bun run test

# Backend
cargo check
cargo test -q
cargo clippy

# Pre-commit (must pass)
pre-commit run -a
```

### Running AI Coding Agents

Launch agents directly via nix develop rather than relying on direnv:

```bash
# Example with Claude Code
nix develop --impure -c claude
```

This avoids occasional shell initialization quirks that can occur when agents
are spawned in a direnv-managed shell.

All dependencies managed through Nix. Do not use pip install or bun install
directly.

---

## Infrastructure

Terraform provisions the server, then NixOS is bootstrapped onto it.

### First-time setup

```bash
# Create and encrypt terraform variables
nix run .#tfCreateVars

# Initialize terraform
nix run .#tfInit

# Plan and apply infrastructure
nix run .#tfPlan
nix run .#tfApply

# Bootstrap NixOS on the provisioned server
nix run .#bootstrap
```

### Deployment

```bash
nix run .#deployAll     # Deploy NixOS config + all services
nix run .#deployNixos   # Deploy NixOS config only
nix run .#deployService -- <profile>  # Deploy a single service
```

### Ongoing operations

```bash
# SSH into the server
nix run .#remote

# Edit terraform variables
nix run .#tfEditVars

# Destroy infrastructure
nix run .#tfDestroy
```

All infrastructure commands use age-encrypted state files. The `-i` flag can be
passed to specify a custom SSH identity file (defaults to `~/.ssh/id_ed25519`).

# AGENTS.md

Rules and guidelines for AI agents working in this repository.

---

## Project Direction

omnix is a composable Nix infrastructure library. See [SPEC.md](./SPEC.md) for
the vision and [ROADMAP.md](./ROADMAP.md) for the path.

---

## Development Commands

```bash
# Check flake validity
nix flake check

# Evaluate modules
nix eval .#nixosModules

# Evaluate lib
nix eval .#lib

# Format Nix files
nixfmt **/*.nix
```

---

## Code Style

### Nix

- Use `lib.mkOption` with proper types for all module options
- Every module must be independently usable (no implicit dependencies on other
  omnix modules)
- Options live under the `omnix.*` namespace
- Use `lib.mkIf cfg.enable` for conditional configuration
- Use `lib.mkDefault` for overridable defaults
- Keep modules focused on a single concern

### Module Interface Design

- Every configurable value must be a module option with a type and description
- Avoid hardcoded project-specific values -- parameterize them
- Prefer `lib.types.str` over `lib.types.path` for values that may come from
  terraform or other dynamic sources
- Group related options under a single `omnix.<module>` prefix

### Library Function Design

- Functions take an attrset of required parameters
- Return an attrset of derivations or values
- Use `pkgs.writeShellApplication` for shell scripts (not raw `writeScript`)
- Include `runtimeInputs` -- never assume tools are on PATH
- All shell scripts must use `set -eo pipefail`

### Testing

- Each module should evaluate without errors in isolation
- Library functions should produce derivations that build
- Template projects should pass `nix flake check`
- Consumer repos using devenv dev shells require `nix flake check --impure`
  (devenv needs impure evaluation to resolve the working directory)

---

## Workflow & Policies

### Quality checks

Never suppress Nix evaluation errors or warnings.

### No application opinions

omnix handles infrastructure. It must never contain:

- Rust build logic
- Frontend build logic
- Dev shell configuration
- CI pipeline definitions
- Application-specific systemd timers or services

These belong in consumer repos. omnix provides the building blocks.

### Composability

Every module and lib function must work independently. A consumer should be able
to use `omnix.nixosModules.disko` without importing any other omnix module. Test
this by evaluating modules in isolation.

### Backwards compatibility

When changing module option interfaces, preserve the old option with
`lib.mkRenamedOptionModule` or `lib.mkRemovedOptionModule` with a clear
migration message.

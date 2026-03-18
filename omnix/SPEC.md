# omnix

Composable Nix infrastructure for DigitalOcean deployments.

## Problem

Every service we deploy follows the same pattern: DigitalOcean droplet with
block storage, NixOS via nixos-anywhere, deploy-rs for atomic deployments,
age-encrypted secrets with ragenix, terraform for provisioning. Each repo copies
the same ~500 lines of Nix and ~100 lines of Terraform with minor
project-specific tweaks. Upgrades (new NixOS version, new secrets backend, new
cloud provider) must be applied independently to every repo.

## Solution

A single Nix flake that provides:

1. **NixOS modules** -- composable, independently usable modules for disk
   layout, cloud-init, SSH hardening, storage mounts, systemd service
   generation, and firewall rules. Each module has a typed option interface
   under the `omnix.*` namespace.

2. **Library functions** -- `mkTerraform`, `mkDeploy`, `mkBootstrap`, `mkRemote`
   that generate the shell scripts for terraform operations, deploy-rs
   orchestration, initial provisioning, and SSH access. Parameterized by
   project-specific values (keys.nix path, node name, service definitions).

3. **Flake templates** -- `nix flake init -t omnix#do-service` scaffolds a
   complete project with all infrastructure wired up. TODOs mark the spots that
   need project-specific values.

4. **Shared inputs** -- ragenix, deploy-rs, disko, and nixos-anywhere are owned
   by omnix. Consumers declare a single `omnix` input and use `follows` for
   nixpkgs. No more duplicating input declarations across repos.

## Design Constraints

- **Composable**: Each module is independently usable. You can use just the
  disko module without the rest.
- **No application opinions**: omnix handles infrastructure. Rust builds,
  frontends, dev shells, CI pipelines stay in each project.
- **Pure Nix**: No devenv.yaml, no wrapper CLIs. Standard Nix flake patterns.
- **DigitalOcean first**: The current modules target DO. The architecture
  supports other cloud providers via additional modules in the future.

## Future

- **secretspec integration**: A custom secretspec provider backed by the `age`
  crate and `keys.nix` role definitions. Declare secrets in `secretspec.toml`,
  store them via age encryption with the same key infrastructure we already use.
- **Additional cloud providers**: AWS, Hetzner modules following the same
  composable pattern.

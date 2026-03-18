# omnix

Composable Nix infrastructure for DigitalOcean deployments. Provides NixOS
modules, library functions, and flake templates for provisioning, deploying, and
managing services on DigitalOcean with terraform, deploy-rs, and age-encrypted
secrets.

## Quick Start

```bash
mkdir my-service && cd my-service
nix flake init -t github:data-cartel/omnix#do-service
# Edit TODOs in flake.nix, os.nix, services.nix, keys.nix
# Set up terraform: nix run .#tfEditVars
# Provision: nix run .#tfInit && nix run .#tfPlan && nix run .#tfApply
# Bootstrap NixOS: nix run .#bootstrap
# Deploy: nix run .#deployAll
```

## Modules

Each module is independently usable under the `omnix.*` namespace:

| Module         | Option prefix          | Purpose                                      |
| -------------- | ---------------------- | -------------------------------------------- |
| `disko`        | `omnix.disko.*`        | GPT disk layout (boot + EFI + root)          |
| `digitalocean` | `omnix.digitalocean.*` | Cloud-init, QEMU guest, GRUB EFI             |
| `base`         | `omnix.base.*`         | SSH hardening, nix GC, flakes, base packages |
| `storage`      | `omnix.storage.*`      | DO block storage volume mount                |
| `services`     | `omnix.services.*`     | Systemd service generation with marker files |
| `firewall`     | `omnix.firewall.*`     | TCP port allowlist (SSH always included)     |

Use `omnix.nixosModules.default` to import all modules at once.

## Library Functions

| Function          | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `lib.mkTerraform` | Terraform wrapper scripts (init, plan, apply, rekey, etc.)                |
| `lib.mkDeploy`    | deploy-rs config + shell wrappers (deployNixos, deployService, deployAll) |
| `lib.mkBootstrap` | nixos-anywhere provisioning + host key update                             |
| `lib.mkRemote`    | SSH helper that resolves host IP from terraform state                     |

## Using as a Flake Input

```nix
{
  inputs = {
    omnix.url = "github:data-cartel/omnix";
    nixpkgs.follows = "omnix/nixpkgs";
  };

  outputs = { self, omnix, nixpkgs, ... }: {
    nixosConfigurations.myservice = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        omnix.inputs.disko.nixosModules.disko
        omnix.inputs.ragenix.nixosModules.default
        omnix.nixosModules.default  # all omnix modules
        ./os.nix
      ];
    };
  };
}
```

See [SPEC.md](./SPEC.md) for design details and [ROADMAP.md](./ROADMAP.md) for
planned work.

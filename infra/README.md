# Host and secrets helpers

Moneymentum no longer owns DigitalOcean Terraform. Cloud resources, encrypted
Terraform state, and `tfPlan` / `tfApply` / `bootstrap` live in the private
[`dataclique/infra`](https://github.com/dataclique/infra) repository under
`terraform/`.

This directory keeps:

- `rekey` -- refresh age recipients for service secrets in `config/secrets.nix`
- `resolveIp` -- ask `dataclique/infra` for the droplet IPv4 used by deploy

## Commands

```bash
nix run .#rekey          # rekey Moneymentum service secrets
nix run .#resolveIp      # print droplet IP via dataclique/infra
nix run .#deployServer   # deploy NixOS + services (needs infra access)
nix run .#deployFrontend
```

`resolveIp` / deploy wrappers look for `INFRA_FLAKE`, then `../infra`, then
`github:dataclique/infra`. Pass `-i` when the SSH identity is not
`~/.ssh/id_ed25519`.

Provision or recreate the droplet from the infra checkout:

```bash
cd ../infra
nix run .#tfPlan
nix run .#tfApply
MONEYMENTUM_FLAKE=../moneymentum nix run .#bootstrap
```

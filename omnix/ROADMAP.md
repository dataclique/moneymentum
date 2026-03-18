# Roadmap

## Migrate consumers to omnix

Extract the library, prove it works by migrating moneymentum, then migrate the
st0x repos. Each migration replaces ~500 lines of duplicated Nix with module
imports and lib calls.

- [ ] Wire moneymentum's flake.nix to use `path:./omnix` as input
- [ ] Migrate st0x.rest.api to use omnix
- [ ] Migrate st0x.liquidity to use omnix
- [ ] Move omnix to its own repo (`data-cartel/omnix`)

## secretspec age provider

Write a custom secretspec provider that uses the `age` crate (the library
backing `rage`) and reads `keys.nix` for recipient public keys. This gives all
omnix consumers declarative secret management via `secretspec.toml` while
keeping the existing age encryption infrastructure.

- [ ] Implement age provider crate following secretspec's `Provider` trait
- [ ] Support `keys.nix` role-based recipient resolution
- [ ] Integrate provider into omnix flake as a package
- [ ] Add secretspec NixOS module to omnix
- [ ] Migrate existing ragenix secrets in moneymentum
- [ ] Migrate existing ragenix secrets in st0x repos

## Not epic

- [ ] Add Hetzner cloud modules (alternative to DigitalOcean)
- [ ] Add ACME/Let's Encrypt module (currently done ad-hoc in each os.nix)
- [ ] Add logrotate module (rest.api has it, others don't)

## Completed

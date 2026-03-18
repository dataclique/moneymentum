# Roadmap

## Migrate consumers to omnix

Extract the library, prove it works by migrating moneymentum, then migrate the
st0x repos. Each migration replaces ~500 lines of duplicated Nix with module
imports and lib calls.

- [ ] Wire moneymentum's flake.nix to use `path:./omnix` as input
- [ ] Migrate st0x.rest.api to use omnix -- simpler case, no service secrets
- [ ] Migrate st0x.liquidity to use omnix -- has ragenix service secrets, needs
      deploy activation changes
- [ ] Move omnix to its own repo (`data-cartel/omnix`)

## Refactor to idiomatic Nix

Clean up the extracted code to be more idiomatic. The initial extraction is a
mechanical copy-paste; this pass makes it proper library-quality Nix.

- [ ] Use NixOS module options consistently -- current lib functions use raw
      attrset args, some could be module options instead for better composition
      and type checking
- [ ] Replace string-interpolated shell scripts with structured
      writeShellApplication patterns -- avoid ad-hoc `${}` Nix-to-bash
      boundaries where possible
- [ ] Use `lib.mkMerge` / `lib.mkIf` patterns instead of `//` attrset merging
      for conditional config
- [ ] Add proper option descriptions and types to all module options -- some are
      missing descriptions
- [ ] Consolidate duplicate `resolveIp` / `parseIdentity` shell fragments --
      currently duplicated between terraform.nix, bootstrap.nix, and remote.nix
- [ ] Add `_module.args` passthrough for omnix-specific config so consumers
      don't need to wire specialArgs manually
- [ ] Break down flake.nix -- separate concerns into importable files (outputs,
      dev shell config, package definitions) so the main flake.nix stays small
      and scannable
- [ ] Organize lib/ more logically -- group related shell fragments, avoid
      duplication between terraform/bootstrap/remote helpers

## secretspec age provider

Write a custom secretspec provider (Rust crate at `crates/secretspec-age/`) that
uses the `age` crate (the library backing `rage`) and reads `keys.nix` for
recipient public keys. This replaces ragenix for on-host secret decryption --
repos like st0x.liquidity use ragenix to decrypt `.toml.age` secrets during
deploy-rs activation, and this provider must support the same workflow: deploy
copies encrypted secrets to the host, the provider decrypts them using the
host's SSH key, and services read plaintext from `/run/agenix/` (or equivalent).

- [ ] Scaffold `crates/secretspec-age/` Rust crate with `age` dependency
- [ ] Implement secretspec `Provider` trait for age encryption/decryption
- [ ] Support `keys.nix` role-based recipient resolution -- parse the Nix
      attrset to extract public keys per role, so the provider knows which keys
      to encrypt to
- [ ] Support on-host decryption using SSH host key -- the host's
      `/etc/ssh/ssh_host_ed25519_key` is the identity for decryption, same as
      ragenix uses today
- [ ] Integrate provider into omnix flake as a package
- [ ] Add secretspec NixOS module to omnix -- declares secrets in
      `secretspec.toml`, replaces ragenix module import
- [ ] Add deploy-rs activation that uses secretspec instead of raw rage commands
      -- deploy profile activation calls the provider CLI to decrypt
- [ ] Migrate existing ragenix secrets in moneymentum
- [ ] Migrate existing ragenix secrets in st0x.liquidity
- [ ] Migrate existing ragenix secrets in st0x.rest.api

## CI generation

The template includes a basic GitHub Actions workflow, but projects need
customized CI (backend tests, frontend lint, clippy, deploy gates). A lib
function or module that generates workflow YAML from Nix config would keep CI in
sync with the build system -- when packages change, CI updates automatically.

- [ ] Design CI generation API -- take a list of checks/builds and produce
      `.github/workflows/ci.yml` content
- [ ] Support common patterns: parallel jobs, nix cache, deploy-on-push,
      submodule caching, SSH key setup
- [ ] Generate deploy job that uses omnix deploy wrappers
- [ ] Support matrix strategies for multi-target builds

## Not epic

- [ ] Add Hetzner cloud modules -- alternative to DigitalOcean for when we need
      better price/performance or EU hosting
- [ ] Add ACME/Let's Encrypt module -- rest.api has this, others proxy through
      nginx on port 80 only
- [ ] Add logrotate module -- rest.api has it, others don't rotate logs at all

## Completed

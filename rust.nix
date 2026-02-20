{ pkgs, craneLib }:

let
  # Include fixtures and migrations alongside standard Cargo sources for tests
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type:
      let base = builtins.baseNameOf path;
      in (craneLib.filterCargoSources path type) || base == "fixtures" || base
      == "migrations" || (pkgs.lib.hasPrefix (toString ./fixtures) path)
      || (pkgs.lib.hasPrefix (toString ./migrations) path);
  };

  # Cargo manifests only — deps derivation hash changes only when dependencies change
  depsSrc = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type:
      let base = builtins.baseNameOf path;
      in type == "directory" || base == "Cargo.toml" || base == "Cargo.lock";
  };

  # Vendor cargo deps with git dependency hashes
  # Use depsSrc (Cargo manifests only) so the vendor hash is stable across
  # source-only changes — vendoring only needs Cargo.toml + Cargo.lock.
  baseVendorDir = craneLib.vendorCargoDeps {
    src = depsSrc;
    cargoLock = ./Cargo.lock;
    outputHashes = {
      "sqlite-es-0.1.0" = "sha256-Pf9nBYz2glSuEvBXnH0+5yqs+ZAOhd7xVTByWt6FMm0=";
    };
  };

  # sqlite-es uses sqlx::migrate!("../../migrations") which resolves inside
  # the vendor dir. Fetch migrations from st0x.issuance at the same commit
  # as Cargo.lock specifies for sqlite-es.
  cargoLock = builtins.fromTOML (builtins.readFile ./Cargo.lock);
  sqliteEsMatches =
    builtins.filter (p: p.name or "" == "sqlite-es") cargoLock.package;
  sqliteEsPackage = if sqliteEsMatches == [ ] then
    builtins.throw
    "sqlite-es not found in Cargo.lock — is the dependency still present?"
  else
    builtins.head sqliteEsMatches;
  sqliteEsRevMatch =
    builtins.match ".*#([a-f0-9]+)" (sqliteEsPackage.source or "");
  sqliteEsRev = if sqliteEsRevMatch == null then
    builtins.throw "could not parse git rev from sqlite-es source: ${
      sqliteEsPackage.source or "<missing>"
    }"
  else
    builtins.head sqliteEsRevMatch;

  sqliteEsMigrations = builtins.fetchGit {
    url = "https://github.com/ST0x-Technology/st0x.issuance";
    rev = sqliteEsRev;
    narHash = "sha256-K9HvodswmWgM6GoP7mszA0eiXDcVuvTwiXqQLI4JUMc=";
  } + "/migrations";

  cargoVendorDir = pkgs.runCommand "vendor-with-migrations" { } ''
    cp -rL --no-preserve=mode ${baseVendorDir} $out

    # sqlite-es's ../../migrations resolves from crate root (sqlite-es-0.1.0/),
    # going up two levels to vendor root
    cp -r ${sqliteEsMigrations} "$out/migrations"

    # config.toml tells cargo where to find vendored crates. It contains
    # absolute nix store paths like:
    #   [source.nix-sources-c798c58f...]
    #   directory = "/nix/store/xxx-vendor-cargo-deps/c798c58f..."
    # We must update these to point to our wrapped vendor dir, otherwise
    # cargo will look in the original (immutable, no migrations) location.
    ${pkgs.gnused}/bin/sed -i "s|${baseVendorDir}|$out|g" $out/config.toml
  '';

  commonArgs = {
    pname = "moneymentum";
    version = "0.1.0";
    inherit src cargoVendorDir;

    nativeBuildInputs = [ pkgs.pkg-config ];

    buildInputs = [ pkgs.openssl pkgs.sqlite ]
      ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin
      [ pkgs.apple-sdk_15 ];

    # Compile-time env for sqlx. Tests are skipped in nix builds.
    DATABASE_URL = "sqlite::memory:";
  };

  cargoArtifacts = craneLib.buildDepsOnly (commonArgs // { src = depsSrc; });

in {
  package = craneLib.buildPackage (commonArgs // {
    inherit cargoArtifacts;
    doCheck = true;
  });

  clippy = craneLib.cargoClippy (commonArgs // {
    inherit cargoArtifacts;
    cargoClippyExtraArgs = "--all-targets -- -D clippy::all";
  });
}

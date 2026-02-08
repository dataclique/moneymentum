{ pkgs, craneLib }:

let
  src = craneLib.cleanCargoSource ./.;

  commonArgs = {
    pname = "moneymentum";
    version = "0.1.0";
    inherit src;

    nativeBuildInputs = [ pkgs.pkg-config ];

    buildInputs = [ pkgs.openssl ]
      ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin
      [ pkgs.apple-sdk_15 ];

    # Compile-time env for sqlx and test code. Tests requiring a real
    # database are skipped in nix builds (no postgres available).
    DATABASE_URL = "postgres://localhost:5432/moneymentum";
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

in {
  package = craneLib.buildPackage (commonArgs // {
    inherit cargoArtifacts;
    # Tests require postgres; run them in devenv instead
    doCheck = false;
  });

  clippy = craneLib.cargoClippy (commonArgs // {
    inherit cargoArtifacts;
    cargoClippyExtraArgs = "--all-targets -- -D clippy::all";
  });
}

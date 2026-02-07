{ pkgs, craneLib }:

let
  src = craneLib.cleanCargoSource ./.;

  commonArgs = {
    pname = "moneymentum";
    version = "0.1.0";
    inherit src;

    buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
      pkgs.darwin.apple_sdk.frameworks.Security
      pkgs.darwin.apple_sdk.frameworks.SystemConfiguration
    ];
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

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

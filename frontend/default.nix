{ pkgs, bun2nix, basePath ? "/" }:

let bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };
in pkgs.stdenv.mkDerivation {
  pname = "moneymentum-frontend";
  version = "0.1.0";
  src = ./.;

  nativeBuildInputs = [ bun2nix.hook pkgs.bun ];

  inherit bunDeps;

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  dontRunLifecycleScripts = true;

  VITE_BASE_PATH = basePath;

  buildPhase = ''
    bun run build
  '';

  installPhase = ''
    cp -r dist $out
  '';

  meta = {
    description = "moneymentum frontend";
    homepage = "https://github.com/data-cartel/moneymentum";
  };
}

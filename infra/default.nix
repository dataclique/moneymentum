{
  pkgs,
  ragenix,
  system,
}:

let
  buildInputs = [
    pkgs.rage
    ragenix.packages.${system}.default
  ];

  parseIdentity = ''
    set -eo pipefail

    identity=~/.ssh/id_ed25519
    if [ "''${1:-}" = "-i" ]; then
      identity="$2"
      shift 2
    fi
  '';

  # Resolve the Moneymentum droplet IP from dataclique/infra Terraform state.
  # INFRA_FLAKE may be a local path (default ../infra) or a flake URL.
  resolveIp = ''
    ${parseIdentity}

    infra_flake="''${INFRA_FLAKE:-}"
    if [ -z "$infra_flake" ]; then
      if [ -d ../infra ]; then
        infra_flake="../infra"
      else
        infra_flake="github:dataclique/infra"
      fi
    fi

    if [ -d "$infra_flake" ]; then
      infra_flake="path:$(cd "$infra_flake" && pwd)"
    fi

    host_ip=$(nix run --impure "$infra_flake#resolveIp" -- -i "$identity")
  '';

  mkTask =
    name: body:
    pkgs.writeShellApplication {
      inherit name;
      runtimeInputs = buildInputs;
      text = body;
    };

in
{
  inherit buildInputs parseIdentity resolveIp;

  rekey = mkTask "rekey" ''
    ${parseIdentity}
    ragenix --rules ./config/secrets.nix -i "$identity" -r
  '';
}

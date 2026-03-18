{ pkgs, keysFile }:

let
  resolveIp = ''
    identity=~/.ssh/id_ed25519
    if [ "''${1:-}" = "-i" ]; then
      identity="$2"
      shift 2
    fi

    if [ -f infra/terraform.tfstate.age ]; then
      rage -d -i "$identity" infra/terraform.tfstate.age > infra/terraform.tfstate
    fi
    host_ip=$(jq -r '.outputs.droplet_ipv4.value' infra/terraform.tfstate)
    rm -f infra/terraform.tfstate
  '';

in pkgs.writeShellApplication {
  name = "remote";
  runtimeInputs = [ pkgs.rage pkgs.jq pkgs.openssh ];
  text = ''
    ${resolveIp}
    exec ssh -i "$identity" "root@$host_ip" "$@"
  '';
}

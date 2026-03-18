{ nixos-anywhere }:

{ pkgs, keysFile, configName, system, ragenixPkg ? null, secretsRules ? null }:

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
  name = "bootstrap-nixos";
  runtimeInputs =
    [ pkgs.rage pkgs.jq pkgs.gnused nixos-anywhere.packages.${system}.default ]
    ++ (if ragenixPkg != null then [ ragenixPkg ] else [ ]);
  text = ''
    ${resolveIp}
    ssh_opts=(-o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$identity")

    nixos-anywhere --flake ".#${configName}" \
      --option pure-eval false \
      --ssh-option "IdentityFile=$identity" \
      --target-host "root@$host_ip" "$@"

    echo "Waiting for host to come back up..."
    retries=0
    until ssh "''${ssh_opts[@]}" "root@$host_ip" true 2>/dev/null; do
      retries=$((retries + 1))
      if [ "$retries" -ge 60 ]; then
        echo "Host did not come back up after 5 minutes" >&2
        exit 1
      fi
      sleep 5
    done

    new_key=$(
      ssh "''${ssh_opts[@]}" "root@$host_ip" \
        cat /etc/ssh/ssh_host_ed25519_key.pub \
        | awk '{print $1 " " $2}'
    )

    sed -i -z \
      's|host =\n      "ssh-ed25519 [^"]*";|host =\n      "'"$new_key"'";|' \
      keys.nix

    if ! grep -q "$new_key" keys.nix; then
      echo "ERROR: host key replacement in keys.nix failed" >&2
      exit 1
    fi

    echo "Updated host key in keys.nix"
    ${if ragenixPkg != null && secretsRules != null then ''
      echo "Rekeying secrets..."
      ragenix --rules ${secretsRules} -i "$identity" -r
    '' else
      ""}
  '';
}

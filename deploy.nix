{ deploy-rs, self }:

let
  system = "x86_64-linux";
  inherit (deploy-rs.lib.${system}) activate;
  profileBase = "/nix/var/nix/profiles/per-service";

  moneymentumPackage = self.packages.${system}.moneymentum;
  frontendPackage = self.packages.${system}.frontend;

  services = import ./services.nix;
  enabledServices = builtins.filter (name: services.${name}.enabled)
    (builtins.attrNames services);

  mkServiceProfile = name:
    let markerFile = "/run/moneymentum/${name}.ready";
    in activate.custom moneymentumPackage (builtins.concatStringsSep " && " [
      "systemctl stop ${name} || true"
      "rm -f ${markerFile}"
      "mkdir -p /run/moneymentum"
      "touch ${markerFile}"
      "systemctl restart ${name}"
    ]);

  mkProfile = name: {
    path = mkServiceProfile name;
    profilePath = "${profileBase}/${name}";
  };

in {
  config = {
    nodes.moneymentum = {
      hostname = "MUST_OVERRIDE_HOSTNAME";
      sshUser = "root";
      user = "root";

      profilesOrder = [ "system" "frontend" ] ++ enabledServices;

      profiles = {
        system.path = activate.nixos self.nixosConfigurations.moneymentum;

        frontend = {
          path = activate.custom frontendPackage ''
            mkdir -p /var/lib/moneymentum
            rm -rf /var/lib/moneymentum/frontend
            cp -rL ${frontendPackage} /var/lib/moneymentum/frontend
            nginx -s reload || true
          '';
          profilePath = "${profileBase}/frontend";
        };
      } // builtins.listToAttrs (map (name: {
        inherit name;
        value = mkProfile name;
      }) enabledServices);
    };
  };

  wrappers = { pkgs, infraPkgs, localSystem }:
    let
      # Only rage (decrypt state) + jq (parse IP) + deploy-rs are needed.
      # infraPkgs.buildInputs also includes terraform and ragenix which
      # deploy scripts never use.
      deployInputs =
        [ pkgs.rage pkgs.jq deploy-rs.packages.${localSystem}.deploy-rs ];

      deployPreamble = ''
        ${infraPkgs.resolveIp}

        if [ -z "$host_ip" ]; then
          echo "ERROR: host_ip not resolved -- check resolveIp or --hostname flag" >&2
          exit 1
        fi

        ssh_flag=""
        if [ "$identity" != "$HOME/.ssh/id_ed25519" ]; then
          export NIX_SSHOPTS="-i $identity"
          ssh_flag="--ssh-opts=-i $identity"
        fi
      '';

      deployFlags = if localSystem == "x86_64-linux" then
        "--skip-checks"
      else
        "--remote-build --skip-checks";

      serviceCleanup = builtins.concatStringsSep "; "
        (map (name: "systemctl reset-failed ${name} || true") enabledServices);

    in {
      deployNixos = pkgs.writeShellApplication {
        name = "deploy-nixos";
        runtimeInputs = deployInputs;
        text = ''
          ${deployPreamble}
          deploy ${deployFlags} --hostname "$host_ip" ''${ssh_flag:+"$ssh_flag"} "$@" .#moneymentum.system
        '';
      };

      deployService = pkgs.writeShellApplication {
        name = "deploy-service";
        runtimeInputs = deployInputs;
        text = ''
          ${deployPreamble}
          profile="''${1:?usage: deploy-service <profile>}"
          shift
          deploy ${deployFlags} --hostname "$host_ip" ''${ssh_flag:+"$ssh_flag"} "$@" ".#moneymentum.$profile"
        '';
      };

      deployAll = pkgs.writeShellApplication {
        name = "deploy-all";
        runtimeInputs = deployInputs ++ [ pkgs.openssh ];
        text = ''
          ${deployPreamble}

          ssh -i "$identity" "root@$host_ip" '${serviceCleanup}'

          deploy ${deployFlags} --hostname "$host_ip" ''${ssh_flag:+"$ssh_flag"} "$@" .#moneymentum
        '';
      };
    };
}

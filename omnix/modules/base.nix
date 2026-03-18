{ lib, config, pkgs, ... }:

let cfg = config.omnix.base;
in {
  options.omnix.base = {
    enable = lib.mkEnableOption "omnix base NixOS settings";

    sshKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "SSH public keys authorized for root login";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional system packages beyond the base set";
    };

    stateVersion = lib.mkOption {
      type = lib.types.str;
      default = "24.11";
      description = "NixOS state version";
    };
  };

  config = lib.mkIf cfg.enable {
    services.openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        PermitRootLogin = "prohibit-password";
      };
    };

    users.users.root.openssh.authorizedKeys.keys = cfg.sshKeys;

    nix = {
      settings = {
        experimental-features = [ "nix-command" "flakes" ];
        auto-optimise-store = true;
        download-buffer-size = 268435456;
      };

      gc = {
        automatic = true;
        dates = "weekly";
        options = "--delete-older-than 30d";
      };
    };

    programs.bash.interactiveShellInit = "set -o vi";

    system.activationScripts.per-service-profiles.text =
      "mkdir -p /nix/var/nix/profiles/per-service";

    environment.systemPackages = with pkgs;
      [ bat curl htop rage zellij ] ++ cfg.extraPackages;

    system.stateVersion = cfg.stateVersion;
  };
}

{ pkgs, lib, modulesPath, frontend, ... }:

let
  inherit (import ./keys.nix) roles;

  services = import ./services.nix;
  enabledServices = lib.filterAttrs (_: v: v.enabled) services;

  mkService = name: cfg:
    let
      path = "/nix/var/nix/profiles/per-service/${name}/bin/${cfg.bin}";
      configFile = ./config/${name}.toml;
    in {
      description = "moneymentum ${cfg.bin} (${name})";

      wantedBy = [ ];

      restartIfChanged = false;
      stopIfChanged = false;

      unitConfig = {
        "X-OnlyManualStart" = true;
        ConditionPathExists = "/run/moneymentum/${name}.ready";
      };

      serviceConfig = {
        DynamicUser = true;
        SupplementaryGroups = [ "moneymentum" ];
        ExecStart = "${path} --config ${configFile}";
        Restart = "always";
        RestartSec = 5;
        ReadWritePaths = [ "/mnt/data" ];
      };
    };

in {
  imports = [
    (modulesPath + "/virtualisation/digital-ocean-config.nix")
    (modulesPath + "/profiles/qemu-guest.nix")
    ./disko.nix
  ];

  boot.loader.grub = {
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  networking.useDHCP = lib.mkForce false;

  services = {
    cloud-init = {
      enable = true;
      network.enable = true;
      settings = {
        datasource_list = [ "ConfigDrive" "Digitalocean" ];
        datasource.ConfigDrive = { };
        datasource.Digitalocean = { };
        cloud_init_modules = [
          "seed_random"
          "bootcmd"
          "write_files"
          "growpart"
          "resizefs"
          "set_hostname"
          "update_hostname"
          "set_password"
        ];
        cloud_config_modules =
          [ "ssh-import-id" "keyboard" "runcmd" "disable_ec2_metadata" ];
        cloud_final_modules = [
          "write_files_deferred"
          "scripts_per_once"
          "scripts_per_boot"
          "scripts_user"
          "ssh_authkey_fingerprints"
          "keys_to_console"
          "install_hotplug"
          "phone_home"
          "final_message"
        ];
      };
    };

    openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        PermitRootLogin = "prohibit-password";
      };
    };

    nginx = {
      enable = true;
      virtualHosts.default = {
        default = true;
        root = "${frontend}";

        locations = {
          "/".tryFiles = "$uri $uri/ /index.html";
          "/api/" = { proxyPass = "http://127.0.0.1:8000/"; };
        };
      };
    };
  };

  users.users.root.openssh.authorizedKeys.keys = roles.ssh;

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [
      22 # SSH
      80 # Frontend
    ];
  };

  fileSystems."/mnt/data" = {
    device = "/dev/disk/by-id/scsi-0DO_Volume_moneymentum-data";
    fsType = "ext4";
  };

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

  users.groups.moneymentum = { };
  programs.bash.interactiveShellInit = "set -o vi";

  systemd.services = lib.mapAttrs mkService enabledServices;

  system.activationScripts.moneymentum-init.text =
    "mkdir -p /run/moneymentum";

  system.activationScripts.per-service-profiles.text =
    "mkdir -p /nix/var/nix/profiles/per-service";

  environment.systemPackages = with pkgs; [
    bat
    curl
    htop
    magic-wormhole
    rage
    zellij
  ];

  system.stateVersion = "24.11";
}

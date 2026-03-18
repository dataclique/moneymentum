{ lib, config, modulesPath, ... }:

let cfg = config.omnix.digitalocean;
in {
  imports = [
    (modulesPath + "/virtualisation/digital-ocean-config.nix")
    (modulesPath + "/profiles/qemu-guest.nix")
  ];

  options.omnix.digitalocean = {
    enable = lib.mkEnableOption "DigitalOcean base configuration";
  };

  config = lib.mkIf cfg.enable {
    boot.loader.grub = {
      efiSupport = true;
      efiInstallAsRemovable = true;
    };

    networking.useDHCP = lib.mkForce false;

    services.cloud-init = {
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
  };
}

{ lib, config, ... }:

let cfg = config.omnix.disko;
in {
  options.omnix.disko = {
    enable = lib.mkEnableOption "omnix GPT disk layout";
    device = lib.mkOption {
      type = lib.types.str;
      default = "/dev/vda";
      description = "Primary disk device path";
    };
  };

  config = lib.mkIf cfg.enable {
    disko.devices.disk.primary = {
      device = lib.mkDefault cfg.device;
      type = "disk";
      content = {
        type = "gpt";
        partitions = {
          boot = {
            size = "1M";
            type = "EF02";
          };
          esp = {
            size = "500M";
            type = "EF00";
            content = {
              type = "filesystem";
              format = "vfat";
              mountpoint = "/boot";
            };
          };
          root = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/";
            };
          };
        };
      };
    };
  };
}

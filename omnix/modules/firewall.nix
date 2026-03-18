{ lib, config, ... }:

let cfg = config.omnix.firewall;
in {
  options.omnix.firewall = {
    enable = lib.mkEnableOption "omnix firewall (SSH always allowed)";

    allowedTCPPorts = lib.mkOption {
      type = lib.types.listOf lib.types.port;
      default = [ ];
      description = "Additional TCP ports to allow (SSH 22 is always included)";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall = {
      enable = true;
      allowedTCPPorts = [ 22 ] ++ cfg.allowedTCPPorts;
    };
  };
}

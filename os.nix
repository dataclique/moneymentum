{ pkgs, lib, ... }:

let
  inherit (import ./keys.nix) roles;

  hlProxy = host: {
    proxyPass = "https://${host}/";
    extraConfig = ''
      proxy_ssl_server_name on;
      proxy_set_header Host ${host};
    '';
  };

in {
  omnix.disko.enable = true;
  omnix.digitalocean.enable = true;

  omnix.base = {
    enable = true;
    sshKeys = roles.ssh;
    stateVersion = "24.11";
    extraPackages = with pkgs; [ magic-wormhole ];
  };

  omnix.storage = {
    enable = true;
    volumeName = "moneymentum-data";
  };

  omnix.services = {
    project = "moneymentum";
    user = "moneymentum";
    group = "warehouse";
    dynamicUser = false;
    configDir = ./config;
    definitions = import ./services.nix;
  };

  omnix.staticSites.definitions = {
    prod = {
      port = 80;
      isDefault = true;
      extraLocations = {
        "/api/" = { proxyPass = "http://127.0.0.1:8000/"; };
        "/hl/" = hlProxy "api.hyperliquid.xyz";
        "/hl-testnet/" = hlProxy "api.hyperliquid-testnet.xyz";
      };
    };

    staging = {
      port = 8080;
      extraLocations = {
        "/api/" = { proxyPass = "http://127.0.0.1:8001/"; };
        "/hl/" = hlProxy "api.hyperliquid.xyz";
        "/hl-testnet/" = hlProxy "api.hyperliquid-testnet.xyz";
      };
    };
  };

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [
      22 # SSH
      80 # Frontend (prod)
      8080 # Frontend (staging)
    ];
  };

  systemd.services.moneymentum-ingest = {
    description = "Trigger moneymentum data ingestion";
    unitConfig.ConditionPathExists = "/run/moneymentum/moneymentum.ready";
    serviceConfig = {
      Type = "oneshot";
      DynamicUser = true;
      ExecStart =
        "${pkgs.curl}/bin/curl -sSf --max-time 300 -X POST http://127.0.0.1:8000/ingest";
    };
  };

  systemd.timers.moneymentum-ingest = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5min";
      OnUnitActiveSec = "6h";
      Persistent = true;
    };
  };
}

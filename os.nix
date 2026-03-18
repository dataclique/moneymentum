{ pkgs, lib, frontend, ... }:

let inherit (import ./keys.nix) roles;
in {
  omnix.disko.enable = true;
  omnix.digitalocean.enable = true;

  omnix.base = {
    enable = true;
    sshKeys = roles.ssh;
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

  omnix.firewall = {
    enable = true;
    allowedTCPPorts = [
      80 # Frontend (prod)
      8080 # Frontend (staging)
    ];
  };

  services.nginx = {
    enable = true;

    virtualHosts.default = {
      default = true;
      listen = [{
        addr = "0.0.0.0";
        port = 80;
      }];
      root = "${frontend}";
      locations = {
        "/".tryFiles = "$uri $uri/ /index.html";
        "/api/" = { proxyPass = "http://127.0.0.1:8000/"; };
        "/hl/" = {
          proxyPass = "https://api.hyperliquid.xyz/";
          extraConfig = ''
            proxy_ssl_server_name on;
            proxy_set_header Host api.hyperliquid.xyz;
          '';
        };
        "/hl-testnet/" = {
          proxyPass = "https://api.hyperliquid-testnet.xyz/";
          extraConfig = ''
            proxy_ssl_server_name on;
            proxy_set_header Host api.hyperliquid-testnet.xyz;
          '';
        };
      };
    };

    virtualHosts.staging = {
      listen = [{
        addr = "0.0.0.0";
        port = 8080;
      }];
      root = "${frontend}";
      locations = {
        "/".tryFiles = "$uri $uri/ /index.html";
        "/api/" = { proxyPass = "http://127.0.0.1:8001/"; };
        "/hl/" = {
          proxyPass = "https://api.hyperliquid.xyz/";
          extraConfig = ''
            proxy_ssl_server_name on;
            proxy_set_header Host api.hyperliquid.xyz;
          '';
        };
        "/hl-testnet/" = {
          proxyPass = "https://api.hyperliquid-testnet.xyz/";
          extraConfig = ''
            proxy_ssl_server_name on;
            proxy_set_header Host api.hyperliquid-testnet.xyz;
          '';
        };
      };
    };
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

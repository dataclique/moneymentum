{ pkgs, lib, ... }:

let inherit (import ./keys.nix) roles;
in {
  omnix.disko.enable = true;
  omnix.digitalocean.enable = true;
  omnix.base = {
    enable = true;
    sshKeys = roles.ssh;
  };
  omnix.storage = {
    enable = true;
    volumeName = "my-service-data";
  };
  omnix.services = {
    project = "my-service";
    configDir = ./config;
    definitions = import ./services.nix;
  };
  omnix.firewall = {
    enable = true;
    allowedTCPPorts = [ 80 ];
  };

  services.nginx = {
    enable = true;
    virtualHosts.default = {
      default = true;
      listen = [{
        addr = "0.0.0.0";
        port = 80;
      }];
      locations."/api/" = { proxyPass = "http://127.0.0.1:8000/"; };
    };
  };
}

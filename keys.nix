rec {
  keys = {
    operator =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHepyxN9hvXzbCY/z0amzldy7DXjNdyetnVaQexRgDEX";
    ci =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHww2/XOFuvQONtwbJF5SFWtKazncH82P7iUmWw1duc6";
    host =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEpgOaoeZ+S6gOOQNF2eBZS9vEUmKDSS0A/cWH7i4HD";
  };

  roles = {
    infra = [ keys.operator keys.ci ];
    service = [ keys.operator ];
    ssh = [ keys.operator keys.ci ];
  };
}

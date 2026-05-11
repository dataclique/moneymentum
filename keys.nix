rec {
  keys = {
    gleb =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHepyxN9hvXzbCY/z0amzldy7DXjNdyetnVaQexRgDEX";
    lev =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILODNt5kMDazw/bX0BpfBtktfbGalzqdIdBgAT5IIdbz lev";
    ci =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHww2/XOFuvQONtwbJF5SFWtKazncH82P7iUmWw1duc6";
    host =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP68uagBaG5Gt5nLJ6G6esXs5fxLbItL3M1qfSrSSVGB";
  };

  roles = with keys; {
    infra = [ ci gleb ];
    service = [ host gleb lev ];
    ssh = [ ci gleb lev ];
  };
}

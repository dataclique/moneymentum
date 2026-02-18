rec {
  keys = {
    gleb =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHepyxN9hvXzbCY/z0amzldy7DXjNdyetnVaQexRgDEX";
    lev =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLtz1pwdaRGeiebJ3qaPj+Xs1wtrTVqxRKlL/cRnCFy";
    ci =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHww2/XOFuvQONtwbJF5SFWtKazncH82P7iUmWw1duc6";
    host =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKt/inM5lJz+CjhIkNEn5p7Ojb1uyshlZ57UfGRSJwIj root@moneymentum-nixos";
  };

  roles = with keys; {
    infra = [ gleb lev ];
    service = [ gleb lev ];
    ssh = [ ci gleb lev ];
  };
}

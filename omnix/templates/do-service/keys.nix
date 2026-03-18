rec {
  keys = {
    operator =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYREPLACEME000000000000000000000";
    ci =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYREPLACEME111111111111111111111";
    host =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYREPLACEME222222222222222222222";
  };

  roles = with keys; {
    infra = [ operator ci ];
    service = [ host operator ];
    ssh = [ operator ci ];
  };
}

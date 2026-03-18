let inherit (import ../keys.nix) roles;
in {
  "terraform.tfstate.age".publicKeys = roles.infra;
  "terraform.tfvars.age".publicKeys = roles.infra;
}

rec {
  keys = {
    # TODO: Replace with actual SSH public keys
    operator = "ssh-ed25519 AAAA_REPLACE_WITH_OPERATOR_KEY";
    host = "ssh-ed25519 AAAA_REPLACE_WITH_HOST_KEY";
    ci = "ssh-ed25519 AAAA_REPLACE_WITH_CI_KEY";
  };

  roles = {
    infra = [ keys.operator keys.ci ];
    service = [ keys.operator keys.host ];
    ssh = [ keys.operator keys.ci ];
  };
}

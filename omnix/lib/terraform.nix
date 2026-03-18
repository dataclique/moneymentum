{ pkgs, keysFile, system, ragenixPkg ? null, secretsRules ? null }:

let
  buildInputs = [ pkgs.terraform pkgs.rage pkgs.jq ]
    ++ (if ragenixPkg != null then [ ragenixPkg ] else [ ]);

  tfState = "infra/terraform.tfstate";
  tfVars = "infra/terraform.tfvars";
  tfPlanFile = "infra/tfplan";

  parseIdentity = ''
    set -eo pipefail

    identity=~/.ssh/id_ed25519
    if [ "''${1:-}" = "-i" ]; then
      identity="$2"
      shift 2
    fi
  '';

  decryptState = ''
    if [ -f ${tfState}.age ]; then
      rage -d -i "$identity" ${tfState}.age > ${tfState}
    fi
  '';

  encryptState = ''
    if [ -f ${tfState} ]; then
      nix eval --raw --file ${keysFile} roles.infra --apply 'builtins.concatStringsSep "\n"' \
        | rage -e -R /dev/stdin -o ${tfState}.age ${tfState}
    fi
  '';

  decryptVars = ''
    rage -d -i "$identity" ${tfVars}.age > ${tfVars}
  '';

  encryptVars = ''
    nix eval --raw --file ${keysFile} roles.infra --apply 'builtins.concatStringsSep "\n"' \
      | rage -e -R /dev/stdin -o ${tfVars}.age ${tfVars}
  '';

  cleanup = "rm -f ${tfState} ${tfState}.backup ${tfVars}";
  cleanupWithPlan = "${cleanup} ${tfPlanFile}";

  preamble = ''
    ${parseIdentity}
    on_exit() { ${cleanup}; }
    trap on_exit EXIT
    ${decryptVars}
  '';

  preambleWithEncrypt = ''
    ${parseIdentity}
    on_exit() {
      ${encryptState}
      ${cleanupWithPlan}
    }
    trap on_exit EXIT
    ${decryptVars}
  '';

  rekeyPreamble = ''
    ${parseIdentity}
    on_exit() {
      ${encryptState}
      ${cleanup}
    }
    trap on_exit EXIT
    ${decryptState}
    ${encryptState}
    ${decryptVars}
    ${encryptVars}
  '';

  resolveIp = ''
    ${parseIdentity}
    ${decryptState}
    host_ip=$(jq -r '.outputs.droplet_ipv4.value' ${tfState})
    rm -f ${tfState}
  '';

  mkTask = name: body:
    pkgs.writeShellApplication {
      inherit name;
      runtimeInputs = buildInputs;
      text = body;
    };

in {
  inherit buildInputs parseIdentity resolveIp;

  tfInit = mkTask "tf-init" ''
    ${preamble}
    terraform -chdir=infra init "$@"
  '';

  tfPlan = mkTask "tf-plan" ''
    ${preamble}
    ${decryptState}
    terraform -chdir=infra plan -out=tfplan "$@"
  '';

  tfApply = mkTask "tf-apply" ''
    ${preambleWithEncrypt}
    ${decryptState}
    terraform -chdir=infra apply "$@" tfplan
  '';

  tfDestroy = mkTask "tf-destroy" ''
    ${preambleWithEncrypt}
    ${decryptState}
    terraform -chdir=infra destroy "$@"
  '';

  tfImport = mkTask "tf-import" ''
    ${preambleWithEncrypt}
    ${decryptState}
    terraform -chdir=infra import "$@"
  '';

  tfEditVars = mkTask "tf-edit-vars" ''
    ${parseIdentity}
    on_exit() { rm -f ${tfVars}; }
    trap on_exit EXIT

    if [ -f ${tfVars}.age ]; then
      ${decryptVars}
    else
      cp ${tfVars}.example ${tfVars}
    fi
    ''${EDITOR:-vi} ${tfVars}
    ${encryptVars}
  '';

  tfRekey = mkTask "tf-rekey" ''
    ${rekeyPreamble}
  '';

  rekey = if ragenixPkg != null && secretsRules != null then
    mkTask "rekey" ''
      ${rekeyPreamble}
      ragenix --rules ${secretsRules} -i "$identity" -r
    ''
  else
    null;

  remote = pkgs.writeShellApplication {
    name = "remote";
    runtimeInputs = [ pkgs.rage pkgs.jq pkgs.openssh ];
    text = ''
      ${resolveIp}
      exec ssh -i "$identity" "root@$host_ip" "$@"
    '';
  };
}

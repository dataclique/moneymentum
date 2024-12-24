{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";

    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";

    devenv.url = "github:cachix/devenv";
    devenv.inputs = {
      nixpkgs.follows = "nixpkgs";
      git-hooks.follows = "git-hooks";
    };
  };

  outputs = { nixpkgs, flake-utils, git-hooks, devenv, ... }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        hooks = {
          # Nix
          nil.enable = true;
          nixfmt-classic.enable = true;

          # Python
          ruff.enable = true;
          ruff-format.enable = true;
          sort-requirements-txt.enable = true;
          denofmt.enable = true;
        };

        deps = with pkgs; [ cacert clang jdk11 ];
        env = { JAVA_HOME = pkgs.jdk11; };
        src = ./.;

      in {
        devShells.default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [{
            # https://devenv.sh/reference/options/
            packages = with pkgs; deps ++ [ ruff-lsp ];
            # enterShell = "fswatch hyper.py | xargs -n 1 python";

            languages = {
              nix.enable = true;
              python = {
                enable = true;
                package = pkgs.python310;
                venv.enable = true;
                venv.requirements = builtins.readFile ./requirements.txt;
                libraries = deps;
              };
            };

            inherit env;
            git-hooks = { inherit hooks; };
            difftastic.enable = true;
            cachix.enable = true;
          }];
        };

        checks.git-hooks = git-hooks.lib.${system}.run { inherit hooks src; };
      });

  nixConfig = {
    extra-substituters = "https://devenv.cachix.org";
    extra-trusted-public-keys =
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
  };
}

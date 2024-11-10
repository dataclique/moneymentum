{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";

    pre-commit-hooks.url = "github:cachix/git-hooks.nix";
    pre-commit-hooks.inputs.nixpkgs.follows = "nixpkgs";

    devenv.url = "github:cachix/devenv";
    devenv.inputs = {
      nixpkgs.follows = "nixpkgs";
      pre-commit-hooks.follows = "pre-commit-hooks";
    };
  };

  outputs = { nixpkgs, flake-utils, pre-commit-hooks, devenv, ... }@inputs:
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

        deps = with pkgs; [ ];
        env = { };
        src = ./.;

      in rec {
        devShells.default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [{
            # https://devenv.sh/reference/options/
            packages = with pkgs; deps ++ [ clang ruff-lsp ];
            enterShell = "fswatch hyper.py | xargs -n 1 python";

            languages = {
              nix.enable = true;
              python = {
                enable = true;
                package = pkgs.python310;
                venv.enable = true;
                venv.requirements = builtins.readFile ./requirements.txt;
              };
            };

            inherit env;
            pre-commit = { inherit hooks; };
            difftastic.enable = true;
            cachix.enable = true;
          }];
        };

        checks.pre-commit =
          pre-commit-hooks.lib.${system}.run { inherit hooks src; };
      });

  nixConfig = {
    extra-substituters = "https://devenv.cachix.org";
    extra-trusted-public-keys =
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
  };
}

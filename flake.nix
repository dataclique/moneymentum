{
  inputs = {
    # Nix
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    systems.url = "github:nix-systems/default";
    flake-utils = {
      url = "github:numtide/flake-utils";
      inputs.systems.follows = "systems";
    };
    pre-commit-hooks = {
      url = "github:cachix/pre-commit-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    devenv = {
      url = "github:cachix/devenv";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pre-commit-hooks.follows = "pre-commit-hooks";
    };
  };

  outputs = { self, nixpkgs, systems, flake-utils, pre-commit-hooks, devenv, ...
    }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        hooks = {
          # Nix
          nil.enable = true;
          nixfmt-classic.enable = true;

          # Python
          black.enable = true;
          ruff.enable = true;

          # Haskell
          hlint.enable = true;
          fourmolu.enable = true;
        };

      in rec {
        packages = {
          devenv-up = self.devShells.${system}.default.config.procfileScript;
        };

        devShells = {
          default = devenv.lib.mkShell {
            inherit inputs pkgs;
            modules = [{
              # https://devenv.sh/reference/options/
              packages = with pkgs; [ git-lfs pyright ];

              languages = {
                # nix.enable = true;
                haskell = {
                  enable = true;
                  stack = pkgs.stack;
                  languageServer = pkgs.haskell-language-server;
                };
                python = {
                  enable = true;
                  venv = {
                    enable = true;
                    quiet = false;
                    requirements = builtins.readFile ./requirements.txt;
                  };
                };
              };

              dotenv.disableHint = true;
              difftastic.enable = true;
              pre-commit.hooks = hooks;
            }];
          };
        };

        checks = {
          pre-commit = pre-commit-hooks.lib.${system}.run {
            src = ./.;
            inherit hooks;
          };
        };
      });

  nixConfig = {
    extra-trusted-public-keys =
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

}

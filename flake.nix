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

  outputs = { self, nixpkgs, flake-utils, git-hooks, devenv, ... }@inputs:
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
        jdbcPath = "${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar";
        injectJdbc = " --driver-class-path ${jdbcPath} --jars ${jdbcPath}";
        env = {
          JDBC_PATH = jdbcPath;
          JAVA_HOME = pkgs.jdk11;
        };
        src = ./.;

      in {
        devShells.default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [{
            # https://devenv.sh/reference/options/
            packages = with pkgs; deps ++ [ ruff-lsp git-lfs timescaledb-tune ];
            # enterShell = "fswatch hyper.py | xargs -n 1 python";

            services.postgres = {
              enable = true;
              extensions = extensions: [ extensions.timescaledb ];
              initialDatabases = [{
                name = "yangdb";
                # schema = ./price_db.sql;
              }];
              initialScript = "CREATE EXTENSION IF NOT EXISTS timescaledb;";
              settings.shared_preload_libraries = "timescaledb";
            };

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

            scripts.flow.exec = "spark-submit ${injectJdbc} $@";
            inherit env;
            git-hooks = { inherit hooks; };
            difftastic.enable = true;
            cachix.enable = true;
          }];
        };

        checks.git-hooks = git-hooks.lib.${system}.run { inherit hooks src; };
        packages.devenv-up =
          self.devShells.${system}.default.config.procfileScript;
      });

  nixConfig = {
    extra-substituters = "https://devenv.cachix.org";
    extra-trusted-public-keys =
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    allow-unfree = true;
  };
}

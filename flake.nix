{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";

    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";

    devenv.url = "github:cachix/devenv";
    devenv.inputs = {
      nixpkgs.follows = "nixpkgs";
      git-hooks.follows = "git-hooks";
    };

    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";

    crane.url = "github:ipetkov/crane";

    ragenix.url = "github:yaxitech/ragenix";
    ragenix.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    nixos-anywhere.url = "github:nix-community/nixos-anywhere";
    nixos-anywhere.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, git-hooks, devenv, rust-overlay, crane
    , ragenix, disko, nixos-anywhere, ... }@inputs:
    {
      nixosConfigurations.moneymentum = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules =
          [ disko.nixosModules.disko ragenix.nixosModules.default ./os.nix ];
      };
    } // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
          config.allowUnfreePredicate = pkg:
            builtins.elem (pkgs.lib.getName pkg) [ "terraform" ];
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default;
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        rustPkgs = pkgs.callPackage ./rust.nix { inherit craneLib; };

        infraPkgs =
          import ./infra { inherit pkgs ragenix nixos-anywhere system; };

        hooks = {
          # Nix
          nil.enable = true;
          nixfmt-classic.enable = true;

          # Python
          mypy.enable = false;
          ruff.enable = true;
          ruff-format.enable = true;
          sort-requirements-txt.enable = true;

          # TypeScript
          eslint = {
            enable = true;
            files = "^frontend/.*\\.(ts|tsx|js|jsx)$";
            entry = "${pkgs.bun}/bin/bun --cwd frontend run lint";
            pass_filenames = false;
          };
          prettier = {
            enable = true;
            excludes = [ "\\.md$" ];
          };

          # TOML
          taplo.enable = true;

          # Markdown
          denofmt = {
            enable = true;
            name = "denofmt";
            entry = "${pkgs.deno}/bin/deno fmt";
            files = "\\.md$";
            pass_filenames = true;
          };

          # Rust - custom entry to avoid git-hooks.nix/nixpkgs version mismatch
          rustfmt = {
            enable = true;
            entry = "${rustToolchain}/bin/cargo fmt --";
            files = "\\.rs$";
            pass_filenames = true;
          };
        };

        deps = with pkgs; [
          cacert
          clang
          jdk17
          zlib
          libffi
          gcc-unwrapped
          stdenv.cc.cc.lib
        ];

        # jdbcPath = "${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar";
        # injectJdbc = " --driver-class-path ${jdbcPath} --jars ${jdbcPath}";
        env = {
          # JDBC_PATH = jdbcPath;
          JAVA_HOME = pkgs.jdk17;
          LD_LIBRARY_PATH = "${pkgs.lib.makeLibraryPath [
            pkgs.zlib
            pkgs.libffi
            pkgs.stdenv.cc.cc.lib
          ]}";
        };

        frontendShell = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [{
            languages.javascript = {
              enable = true;
              directory = "frontend";
              bun = {
                enable = true;
                install.enable = true;
              };
            };
          }];
        };

        devShell = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [
            ({ config, ... }: {
              # https://devenv.sh/reference/options/
              packages = with pkgs;
                deps ++ [
                  ragenix.packages.${system}.default
                  sqlx-cli
                  infraPkgs.remote
                ];

              languages = {
                nix.enable = true;

                python = {
                  enable = true;
                  package = pkgs.python311;
                  venv.enable = true;
                  venv.requirements = builtins.readFile ./requirements.txt;
                  libraries = deps
                    ++ [ pkgs.zlib pkgs.libffi pkgs.stdenv.cc.cc.lib ];
                };

                javascript = {
                  enable = true;
                  directory = "frontend";
                  bun = {
                    enable = true;
                    install.enable = true;
                  };
                };

                rust = {
                  enable = true;
                  toolchain.rustc = rustToolchain;
                  toolchain.cargo = rustToolchain;
                  toolchain.rustfmt = rustToolchain;
                  toolchain.clippy = rustToolchain;
                };
              };

              services.postgres = {
                enable = true;
                initialDatabases = [{ name = "moneymentum"; }];
                listen_addresses = "127.0.0.1";
              };

              # DATABASE_URL is read by sqlx for compile-time query verification
              # and by migration tooling. The runtime config uses database_url field.
              env = env // {
                DATABASE_URL =
                  "postgres://localhost:5432/moneymentum?sslmode=disable";
              };

              # Use pre-commit instead of git-hooks
              git-hooks = { inherit hooks; };

              difftastic.enable = true;
              cachix.enable = true;
            })
          ];
        };

      in {
        devShells.default = devShell;
        devShells.frontend = frontendShell;

        checks.git-hooks = git-hooks.lib.${system}.run {
          inherit hooks;
          src = self;
        };
        packages = {
          devenv-up = devShell.config.procfileScript;
          default = rustPkgs.package;
          moneymentum = rustPkgs.package;
          moneymentum-clippy = rustPkgs.clippy;

          inherit (infraPkgs)
            tfInit tfPlan tfApply tfDestroy tfEditVars tfCreateVars bootstrap
            remote;
        };
      });

  nixConfig = {
    extra-substituters = "https://devenv.cachix.org";
    extra-trusted-public-keys =
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    allow-unfree = true;
  };
}

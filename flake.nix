{
  inputs = {
    omnix.url = "path:./omnix";

    nixpkgs.follows = "omnix/nixpkgs";
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

    bun2nix.url = "github:nix-community/bun2nix?tag=2.0.7";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, omnix, nixpkgs, flake-utils, git-hooks, devenv, rust-overlay
    , crane, bun2nix, ... }@inputs:
    let
      services = import ./services.nix;

      deployConfig = omnix.lib.mkDeploy {
        inherit self services;
        nodeName = "moneymentum";
        package = self.packages.x86_64-linux.moneymentum;
      };
    in {
      nixosConfigurations.moneymentum = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { frontend = self.packages.x86_64-linux.frontend; };

        modules = [
          omnix.inputs.disko.nixosModules.disko
          omnix.inputs.ragenix.nixosModules.default
          omnix.nixosModules.default
          ./os.nix
        ];
      };

      deploy = deployConfig.config;
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

        infraPkgs = omnix.lib.mkTerraform {
          inherit pkgs system;
          keysFile = ./keys.nix;
          ragenixPkg = omnix.inputs.ragenix.packages.${system}.default;
          secretsRules = ./config/secrets.nix;
        };

        deployPkgs = deployConfig.wrappers {
          inherit pkgs infraPkgs;
          localSystem = system;
        };

        hooks = {
          nil.enable = true;
          nixfmt-classic.enable = true;

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

          taplo.enable = true;

          denofmt = {
            enable = true;
            name = "denofmt";
            entry = "${pkgs.deno}/bin/deno fmt";
            files = "\\.md$";
            pass_filenames = true;
          };

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

        env = {
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
              packages = with pkgs;
                deps ++ [
                  git
                  omnix.inputs.ragenix.packages.${system}.default
                  sqlx-cli
                  doctl
                  infraPkgs.remote
                  deployPkgs.deployNixos
                  deployPkgs.deployService
                  deployPkgs.deployAll
                ];

              languages = {
                nix.enable = true;
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

              env = env // {
                DATABASE_URL = "sqlite:./moneymentum.db?mode=rwc";
                PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
              };

              git-hooks = { inherit hooks; };

              difftastic.enable = true;
              cachix.enable = true;
            })
          ];
        };

      in {
        devShells.default = devShell;
        devShells.frontend = frontendShell;

        checks = {
          git-hooks = git-hooks.lib.${system}.run {
            inherit hooks;
            src = self;
          };
        };
        packages = {
          default = rustPkgs.package;
          moneymentum = rustPkgs.package;
          moneymentum-clippy = rustPkgs.clippy;

          frontend = pkgs.callPackage ./frontend {
            bun2nix = bun2nix.packages.${system}.default;
          };

          resolveIp = pkgs.writeShellApplication {
            name = "resolve-ip";
            runtimeInputs = [ pkgs.rage pkgs.jq ];
            text = ''
              ${infraPkgs.resolveIp}
              echo "$host_ip"
            '';
          };

          inherit (infraPkgs)
            tfInit tfPlan tfApply tfImport tfEditVars tfRekey remote;

          bootstrap = omnix.lib.mkBootstrap {
            inherit pkgs system;
            keysFile = ./keys.nix;
            configName = "moneymentum";
            ragenixPkg = omnix.inputs.ragenix.packages.${system}.default;
            secretsRules = ./config/secrets.nix;
          };

          inherit (deployPkgs) deployNixos deployService deployAll;
        };
      });

  nixConfig = {
    extra-substituters =
      [ "https://devenv.cachix.org" "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
    allow-unfree = true;
  };
}

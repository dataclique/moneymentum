{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-parts.url = "github:hercules-ci/flake-parts";

    omnix.url =
      "github:data-cartel/omnix?rev=42cfcaf2f5ce76459b1fc341ec92675cad49b168";
    omnix.inputs.nixpkgs.follows = "nixpkgs";

    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";

    devenv.url = "github:cachix/devenv/v2.0.5";
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

  outputs = inputs@{ self, omnix, nixpkgs, flake-parts, git-hooks, devenv
    , rust-overlay, crane, bun2nix, ... }:
    let
      services = import ./services.nix;

      deployConfig = omnix.lib.mkDeploy {
        inherit self services;
        nodeName = "moneymentum";
        package = self.packages.x86_64-linux.moneymentum;
        staticSites = {
          prod = {
            enabled = true;
            package = self.packages.x86_64-linux.frontend;
          };
          staging = {
            enabled = true;
            package = self.packages.x86_64-linux.frontend;
          };
        };
      };
    in flake-parts.lib.mkFlake { inherit inputs; } {
      systems =
        [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      flake = {
        nixosConfigurations.moneymentum = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [ omnix.nixosModules.default ./os.nix ];
        };

        deploy = deployConfig.config;
      };

      perSystem = { system, ... }:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
            config.allowUnfreePredicate = pkg:
              builtins.elem (nixpkgs.lib.getName pkg) [ "terraform" ];
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

        in {
          devShells.default = devenv.lib.mkShell {
            inherit inputs pkgs;
            modules = [
              ({ ... }: {
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
              excludeShellChecks = [ "SC2154" ];
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
        };
    };

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

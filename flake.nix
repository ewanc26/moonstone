{
  description = "moonstone — personal ATProto PDS";

  inputs = {
    nixpkgs.url    = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        # Pin Rust to match rust-toolchain.toml (1.86)
        rustToolchain = pkgs.rust-bin.stable."1.86.0".default;

        nodejs = pkgs.nodejs_20;

        # ---------------------------------------------------------------------------
        # @ewanc26/moonstone-native — Rust neon addon
        # ---------------------------------------------------------------------------
        nativeAddon = pkgs.stdenv.mkDerivation {
          pname   = "moonstone-native";
          version = "0.1.0";
          src     = ./.;

          nativeBuildInputs = [
            rustToolchain
            pkgs.pkg-config
            nodejs
            pkgs.pnpm
          ];
          buildInputs = [ pkgs.openssl ];

          buildPhase = ''
            export HOME=$(mktemp -d)
            cd packages/native
            cargo build --release --manifest-path Cargo.toml
            cp ../../target/release/libmoonstone_native.so index.node 2>/dev/null || \
            cp ../../target/release/libmoonstone_native.dylib index.node 2>/dev/null || \
            cp ../../target/release/moonstone_native.dll index.node 2>/dev/null
          '';

          installPhase = ''
            mkdir -p $out
            cp index.node $out/
            cp package.json $out/
            cp index.d.ts $out/
          '';
        };

        # ---------------------------------------------------------------------------
        # @ewanc26/moonstone-server — full server build (TS + native addon)
        # ---------------------------------------------------------------------------
        moonstoneServer = pkgs.buildNpmPackage {
          pname   = "moonstone-server";
          version = "0.1.0";
          src     = ./.;

          # Fill in with: cd moonstone && prefetch-npm-deps pnpm-lock.yaml
          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

          nativeBuildInputs = [ nodejs pkgs.pnpm rustToolchain pkgs.pkg-config ];
          buildInputs = [ pkgs.openssl ];

          buildPhase = ''
            export HOME=$(mktemp -d)
            # 1. Build @ewanc26/moonstone-native
            cargo build --release
            cp target/release/libmoonstone_native.so packages/native/index.node 2>/dev/null || \
            cp target/release/libmoonstone_native.dylib packages/native/index.node 2>/dev/null || true
            # 2. Install JS deps + build @ewanc26/moonstone-config and @ewanc26/moonstone-server
            pnpm install --frozen-lockfile
            pnpm run build:ts
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/moonstone

            # @ewanc26/moonstone-server dist
            cp -r packages/server/dist $out/lib/moonstone/server
            cp packages/server/package.json $out/lib/moonstone/

            # @ewanc26/moonstone-native addon
            install -Dm755 packages/native/index.node $out/lib/moonstone/native/index.node
            cp packages/native/package.json $out/lib/moonstone/native/

            # node_modules (needed at runtime for @atproto/pds etc.)
            cp -r node_modules $out/lib/moonstone/

            # Entrypoint wrapper
            cat > $out/bin/moonstone-pds <<'EOF'
            #!/usr/bin/env ${nodejs}/bin/node
            import('${placeholder "out"}/lib/moonstone/server/index.js')
            EOF
            chmod +x $out/bin/moonstone-pds
          '';
        };
      in
      {
        packages = {
          native = nativeAddon;
          server = moonstoneServer;
          default = moonstoneServer;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            nodejs
            pkgs.pnpm
            rustToolchain
            pkgs.pkg-config
            pkgs.openssl
          ];
        };
      }
    ) // {
      nixosModules.moonstone = import ./nix/module.nix;
    };
}

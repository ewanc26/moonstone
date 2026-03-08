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
        # Rust native addon build
        # ---------------------------------------------------------------------------
        # cargo-cp-artifact copies the compiled .so/.dylib/.dll to index.node
        # after the cargo build. We run this in the native package directory.
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
            # Build the neon addon with cargo
            cargo build --release --manifest-path Cargo.toml
            # Copy the compiled artifact to index.node
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
        # Full server build (TypeScript + native addon bundled)
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
            # 1. Build native addon
            cargo build --release
            cp target/release/libmoonstone_native.so packages/native/index.node 2>/dev/null || \
            cp target/release/libmoonstone_native.dylib packages/native/index.node 2>/dev/null || true
            # 2. Install JS deps + build TS
            pnpm install --frozen-lockfile
            pnpm run build:ts
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/moonstone

            # Server dist
            cp -r packages/server/dist $out/lib/moonstone/server
            cp packages/server/package.json $out/lib/moonstone/

            # Native addon
            install -Dm755 packages/native/index.node $out/lib/moonstone/native/index.node
            cp packages/native/package.json $out/lib/moonstone/native/

            # node_modules (needed at runtime for @atproto/pds etc.)
            cp -r node_modules $out/lib/moonstone/

            # Entrypoint wrapper
            cat > $out/bin/moonstone-pds <<'EOF'
            #!/usr/bin/env ${nodejs}/bin/node
            // Resolve the ESM entry point
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
      # NixOS module — wire in nix-config as:
      #   inputs.moonstone.url = "github:ewanc26/moonstone";
      #   modules = [ inputs.moonstone.nixosModules.moonstone ];
      nixosModules.moonstone = import ./nix/module.nix;
    };
}

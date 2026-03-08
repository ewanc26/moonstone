{
  description = "moonstone — personal ATProto PDS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_20;

        # Build the @moonstone/server package via pnpm.
        moonstoneServer = pkgs.buildNpmPackage {
          pname = "moonstone-server";
          version = "0.1.0";
          src = ./.;

          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          # ↑ Run `nix-prefetch-url --unpack` or use `prefetch-npm-deps` to fill this in.

          nativeBuildInputs = [ nodejs pkgs.pnpm ];

          buildPhase = ''
            pnpm install --frozen-lockfile
            pnpm build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/moonstone
            cp -r packages/server/dist $out/lib/moonstone/
            cp packages/server/package.json $out/lib/moonstone/
            cp -r node_modules $out/lib/moonstone/

            cat > $out/bin/moonstone-pds <<EOF
            #!/usr/bin/env ${nodejs}/bin/node
            import('$out/lib/moonstone/dist/index.js')
            EOF
            chmod +x $out/bin/moonstone-pds
          '';
        };
      in
      {
        packages = {
          server = moonstoneServer;
          default = moonstoneServer;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ nodejs pkgs.pnpm ];
        };
      }
    ) // {
      # NixOS module — import in nix-config:
      #   inputs.moonstone.url = "github:ewanc26/moonstone";
      #   imports = [ inputs.moonstone.nixosModules.moonstone ];
      nixosModules.moonstone = import ./nix/module.nix;
    };
}

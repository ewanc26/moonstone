# moonstone

Personal ATProto PDS — optimised for NixOS/Caddy, no Bluesky infrastructure defaults.

***I DO NOT RECOMMEND YOU DEPLOY, THIS IS EXPERIMENTAL AND COMPLETELY DONE FOR FUN. I DO NOT INTEND TO MAINTAIN IT AFTER IT IS IN A WORKING STATE.***

Wraps [`@atproto/pds`](https://github.com/bluesky-social/atproto) with:

- **No Bluesky infra defaults** — no `api.bsky.app`, `mod.bsky.app` etc. wired in.
- **`did:plc` supported** — via configurable `PDS_PLC_URL` (defaults to `plc.directory`, the canonical ATProto PLC registry).
- **Rust identity layer** (`@ewanc26/moonstone-native`) — handle/DID syntax validation and async identity resolution backed by [`rsky-syntax`](https://github.com/blacksky-algorithms/rsky) and [`rsky-identity`](https://github.com/blacksky-algorithms/rsky) via neon N-API bindings.
- **Typed, validated config** — zod schema, personal-PDS defaults, fast-fail on missing secrets.
- **Self-contained** — all dependencies declared within this repo (git deps for rsky crates; no path deps outside the folder).
- **NixOS module** at `nix/module.nix` — SOPS secrets, systemd service, Caddy virtualHost.

## Packages

| Package | Description |
| --- | --- |
| `@ewanc26/moonstone-config` | Env parsing + zod validation |
| `@ewanc26/moonstone-native` | Rust native addon (neon) — syntax validation + DID/handle resolution |
| `@ewanc26/moonstone-server` | PDS server entry point |

## Quick start

```sh
# 1. Build the Rust native addon
pnpm run build:native

# 2. Build TypeScript
pnpm run build:ts

# 3. Set env vars (see .env.example)
cp .env.example .env && $EDITOR .env

# 4. Run
node packages/server/dist/index.js
```

Required env vars (injected via SOPS in production):

```sh
PDS_HOSTNAME=pds.example.com
PDS_JWT_SECRET=<openssl rand --hex 16>
PDS_ADMIN_PASSWORD=<openssl rand --hex 16>
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=<see .env.example>
```

## Federation

moonstone defaults to the relay list from `nix-config options.nix` — a broad set of independent ATProto relays plus `bsky.network`. To use a different set, override `PDS_CRAWLERS` with a comma-separated list:

```sh
PDS_CRAWLERS=https://relay.cerulea.blue,https://relay.feeds.blue
```

To disable all relay announcements entirely:

```sh
PDS_CRAWLERS=
```

`did:plc` resolution uses `plc.directory` by default — an ATProto protocol dependency, not a Bluesky product. Override with `PDS_PLC_URL` to point at a self-hosted PLC directory.

## NixOS

See [`nix/module.nix`](./nix/module.nix). Add to `nix-config`:

```nix
inputs.moonstone.url = "github:ewanc26/moonstone";
# pass as specialArgs and import the module
imports = [ inputs.moonstone.nixosModules.moonstone ];
```

## License

AGPL-3.0-only

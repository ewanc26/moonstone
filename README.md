# moonstone

Personal ATProto PDS implementation, optimised for NixOS/Caddy deployment.

Wraps [`@atproto/pds`](https://github.com/bluesky-social/atproto) with:

- **Full TypeScript + ESM** — no CJS entrypoints
- **Typed, validated config** — zod schema, personal-PDS defaults, fast-fail on missing secrets
- **Stripped defaults** — invites off, disk blobstore, no Redis, no email required
- **NixOS module** at `nix/module.nix` — SOPS secrets, systemd service, Caddy virtualHost

## Packages

| Package | Description |
| --- | --- |
| `@moonstone/config` | Env parsing + validation |
| `@moonstone/server` | PDS server entry point |

## Usage

```sh
pnpm install
pnpm build
node packages/server/dist/index.js
```

Required env vars (typically injected via SOPS):

```
PDS_HOSTNAME=pds.example.com
PDS_JWT_SECRET=<openssl rand --hex 16>
PDS_ADMIN_PASSWORD=<openssl rand --hex 16>
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=<see atproto docs>
```

## NixOS

See [`nix/module.nix`](./nix/module.nix) for the NixOS module and
[`nix/README.md`](./nix/README.md) for integration notes.

## License

AGPL-3.0-only

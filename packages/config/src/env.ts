import { z } from 'zod'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const commaSep = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
// Design constraints:
//   - NO Bluesky infrastructure defaults (no api.bsky.app, mod.bsky.app, etc.)
//   - plc.directory is the default did:plc registry — this is an ATProto
//     protocol dependency, not a Bluesky product. Override freely.
//   - AppView, mod service, report service are entirely absent unless set.

export const EnvSchema = z.object({
  // --- Required ----------------------------------------------------------------
  PDS_HOSTNAME: z.string().min(1),
  PDS_JWT_SECRET: z.string().min(16),
  PDS_ADMIN_PASSWORD: z.string().min(8),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: z.string().min(1),

  // --- Identity ----------------------------------------------------------------
  // did:plc registry — defaults to plc.directory (protocol requirement, not
  // Bluesky-specific; Bluesky just happens to operate the canonical one).
  PDS_PLC_URL: z.string().url().default('https://plc.directory'),
  // Override the service DID — defaults to did:web:<hostname>
  PDS_SERVICE_DID: z.string().optional(),

  // --- Service -----------------------------------------------------------------
  PDS_PORT: z.coerce.number().int().positive().default(2583),
  PDS_DATA_DIRECTORY: z.string().default('/srv/moonstone-pds'),
  PDS_VERSION: z.string().optional(),
  PDS_DEV_MODE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  // --- Blobstore (disk-only; S3 paths intentionally absent) ---------------------
  PDS_BLOBSTORE_DISK_LOCATION: z.string().optional(), // defaults to DATA_DIRECTORY/blobs
  PDS_BLOBSTORE_DISK_TMP_LOCATION: z.string().optional(),
  PDS_BLOB_UPLOAD_LIMIT: z.coerce.number().int().positive().default(5 * 1024 * 1024), // 5 MiB

  // --- Handles -----------------------------------------------------------------
  // Defaults to .<hostname>
  PDS_SERVICE_HANDLE_DOMAINS: commaSep.optional(),

  // --- Actor store -------------------------------------------------------------
  PDS_ACTOR_STORE_CACHE_SIZE: z.coerce.number().int().positive().default(100),

  // --- Admin -------------------------------------------------------------------
  PDS_ADMIN_EMAIL: z.string().email().optional(),

  // --- Email -------------------------------------------------------------------
  // Both must be set or neither — any partial config will throw at runtime.
  PDS_EMAIL_SMTP_URL: z.string().optional(),
  PDS_EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // --- Crawlers ----------------------------------------------------------------
  // Defaults match the crawlers list in nix-config options.nix.
  // Override by setting PDS_CRAWLERS to a comma-separated list, or set to an
  // empty string to disable all announcements.
  PDS_CRAWLERS: commaSep.default(
    [
      'https://bsky.network',
      'https://relay.cerulea.blue',
      'https://relay.fire.hose.cam',
      'https://relay2.fire.hose.cam',
      'https://relay3.fr.hose.cam',
      'https://relay.hayescmd.net',
      'https://relay.xero.systems',
      'https://relay.upcloud.world',
      'https://relay.feeds.blue',
      'https://atproto.africa',
      'https://northamerica.firehose.network',
      'https://europe.firehose.network',
      'https://asia.firehose.network',
    ].join(','),
  ),
})
  .refine(
    (d) => !((d.PDS_EMAIL_SMTP_URL && !d.PDS_EMAIL_FROM_ADDRESS) ||
              (!d.PDS_EMAIL_SMTP_URL && d.PDS_EMAIL_FROM_ADDRESS)),
    { message: 'PDS_EMAIL_SMTP_URL and PDS_EMAIL_FROM_ADDRESS must both be set, or neither' },
  )

export type MoonstoneEnv = z.infer<typeof EnvSchema>

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
//   - NO third-party infrastructure defaults.
//   - plc.directory is the default did:plc registry — this is an ATProto
//     protocol dependency. Override freely via PDS_PLC_URL.
//   - AppView, mod service, report service are absent unless explicitly set.
//   - Crawlers default to empty — opt-in only.

export const EnvSchema = z.object({
  // --- Required ----------------------------------------------------------------
  PDS_HOSTNAME: z.string().min(1),
  PDS_JWT_SECRET: z.string().min(16),
  PDS_ADMIN_PASSWORD: z.string().min(8),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: z.string().min(1),

  // --- Identity ----------------------------------------------------------------
  // did:plc registry — defaults to plc.directory (ATProto protocol standard).
  // Override to use an alternative registry (e.g. self-hosted).
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

  // --- Blobstore (disk-only) ---------------------------------------------------
  PDS_BLOBSTORE_DISK_LOCATION: z.string().optional(),
  PDS_BLOBSTORE_DISK_TMP_LOCATION: z.string().optional(),
  PDS_BLOB_UPLOAD_LIMIT: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  // --- Handles -----------------------------------------------------------------
  PDS_SERVICE_HANDLE_DOMAINS: commaSep.optional(),

  // --- Actor store -------------------------------------------------------------
  PDS_ACTOR_STORE_CACHE_SIZE: z.coerce.number().int().positive().default(100),

  // --- Admin -------------------------------------------------------------------
  PDS_ADMIN_EMAIL: z.string().email().optional(),

  // --- Email -------------------------------------------------------------------
  PDS_EMAIL_SMTP_URL: z.string().optional(),
  PDS_EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // --- AppView -----------------------------------------------------------------
  // Set both to proxy app.bsky.* (and other unhandled XRPC) to an AppView.
  // The appView can be any ATProto AppView — Bluesky's or any alternative.
  // PDS_APP_VIEW_URL / PDS_APP_VIEW_DID are the canonical names.
  // PDS_BSKY_APP_VIEW_* are accepted as deprecated aliases.
  PDS_APP_VIEW_URL: z.string().url().optional(),
  PDS_APP_VIEW_DID: z.string().optional(),
  // Deprecated aliases — still accepted, lower priority than canonical names.
  PDS_BSKY_APP_VIEW_URL: z.string().url().optional(),
  PDS_BSKY_APP_VIEW_DID: z.string().optional(),

  // --- Crawlers ----------------------------------------------------------------
  // Defaults to empty — operators opt in to relay announcements.
  // Set to a comma-separated list of relay URLs to enable.
  PDS_CRAWLERS: commaSep.default(''),
})
  .refine(
    (d) => !((d.PDS_EMAIL_SMTP_URL && !d.PDS_EMAIL_FROM_ADDRESS) ||
              (!d.PDS_EMAIL_SMTP_URL && d.PDS_EMAIL_FROM_ADDRESS)),
    { message: 'PDS_EMAIL_SMTP_URL and PDS_EMAIL_FROM_ADDRESS must both be set, or neither' },
  )

export type MoonstoneEnv = z.infer<typeof EnvSchema>

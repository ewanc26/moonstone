import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
// Personal-PDS profile: disk blobstore, invites off, no Redis, no email.
// Secrets are injected via SOPS at runtime; this schema validates them at
// startup so the process crashes loudly rather than misbehaving silently.

const commaSep = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))

export const EnvSchema = z.object({
  // --- Required ----------------------------------------------------------------
  PDS_HOSTNAME: z.string().min(1),
  PDS_JWT_SECRET: z.string().min(16),
  PDS_ADMIN_PASSWORD: z.string().min(8),

  // --- Identity ----------------------------------------------------------------
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: z.string().optional(),
  PDS_SERVICE_DID: z.string().optional(),
  PDS_PLC_URL: z.string().url().default('https://plc.directory'),

  // --- Service -----------------------------------------------------------------
  PDS_PORT: z.coerce.number().int().positive().default(2583),
  PDS_DATA_DIRECTORY: z.string().default('/srv/bluesky-pds'),
  PDS_VERSION: z.string().optional(),

  // --- Blobstore ---------------------------------------------------------------
  // Disk-only; S3 paths are intentionally absent.
  PDS_BLOBSTORE_DISK_LOCATION: z.string().optional(), // defaults to DATA_DIRECTORY/blobs
  PDS_BLOBSTORE_DISK_TMP_LOCATION: z.string().optional(),
  PDS_BLOB_UPLOAD_LIMIT: z.coerce.number().int().positive().default(5 * 1024 * 1024), // 5 MiB

  // --- Handles -----------------------------------------------------------------
  PDS_SERVICE_HANDLE_DOMAINS: commaSep.optional(),

  // --- Crawlers ----------------------------------------------------------------
  PDS_CRAWLERS: commaSep.default('https://bsky.network'),

  // --- Actor store -------------------------------------------------------------
  PDS_ACTOR_STORE_CACHE_SIZE: z.coerce.number().int().positive().default(100),

  // --- Admin -------------------------------------------------------------------
  PDS_ADMIN_EMAIL: z.string().email().optional(),

  // --- Dev ---------------------------------------------------------------------
  PDS_DEV_MODE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
})

export type MoonstoneEnv = z.infer<typeof EnvSchema>

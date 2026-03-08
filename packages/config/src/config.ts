import path from 'node:path'
import { EnvSchema, type MoonstoneEnv } from './env.js'

// ---------------------------------------------------------------------------
// Exported config shape
// ---------------------------------------------------------------------------

export type MoonstoneConfig = {
  service: {
    port: number
    hostname: string
    publicUrl: string
    did: string
    version?: string
    devMode: boolean
    blobUploadLimit: number
  }
  db: { directory: string }
  blobstore: { location: string; tempLocation?: string }
  identity: {
    plcUrl: string
    serviceHandleDomains: string[]
  }
  email: { smtpUrl: string; fromAddress: string } | null
  crawlers: string[]
}

// ---------------------------------------------------------------------------
// Parse + validate from process.env
// ---------------------------------------------------------------------------

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): MoonstoneEnv {
  const result = EnvSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`moonstone: invalid configuration\n${issues}`)
  }
  return result.data
}

export function buildConfig(env: MoonstoneEnv): MoonstoneConfig {
  const hostname = env.PDS_HOSTNAME
  const port = env.PDS_PORT
  const dataDir = env.PDS_DATA_DIRECTORY

  return {
    service: {
      port,
      hostname,
      publicUrl: hostname === 'localhost'
        ? `http://localhost:${port}`
        : `https://${hostname}`,
      did: env.PDS_SERVICE_DID ?? `did:web:${hostname}`,
      version: env.PDS_VERSION,
      devMode: env.PDS_DEV_MODE,
      blobUploadLimit: env.PDS_BLOB_UPLOAD_LIMIT,
    },
    db: { directory: dataDir },
    blobstore: {
      location: env.PDS_BLOBSTORE_DISK_LOCATION ?? path.join(dataDir, 'blobs'),
      tempLocation: env.PDS_BLOBSTORE_DISK_TMP_LOCATION,
    },
    identity: {
      plcUrl: env.PDS_PLC_URL,
      serviceHandleDomains: env.PDS_SERVICE_HANDLE_DOMAINS ?? [`.${hostname}`],
    },
    email: env.PDS_EMAIL_SMTP_URL && env.PDS_EMAIL_FROM_ADDRESS
      ? { smtpUrl: env.PDS_EMAIL_SMTP_URL, fromAddress: env.PDS_EMAIL_FROM_ADDRESS }
      : null,
    // Opt-in only — undefined means no crawlers registered.
    crawlers: env.PDS_CRAWLERS ?? [],
  }
}

// ---------------------------------------------------------------------------
// Bridge: MoonstoneEnv → @atproto/pds ServerEnvironment shape
//
// @atproto/pds reads process.env via readEnv(). Rather than re-parsing from
// scratch, we build the equivalent ServerEnvironment object so we can call
// envToCfg() / envToSecrets() directly.
//
// Intentionally omitted (no Bluesky infrastructure):
//   bskyAppViewUrl, bskyAppViewDid     — AppView is opt-out by default
//   modServiceUrl, modServiceDid       — Mod service not wired in
//   reportServiceUrl, reportServiceDid — Report service not wired in
// ---------------------------------------------------------------------------

export function toAtprotoEnv(env: MoonstoneEnv): Record<string, unknown> {
  const hostname = env.PDS_HOSTNAME
  const dataDir = env.PDS_DATA_DIRECTORY

  return {
    port:                hostname === 'localhost' ? env.PDS_PORT : undefined,
    hostname,
    serviceDid:          env.PDS_SERVICE_DID,
    version:             env.PDS_VERSION,
    devMode:             env.PDS_DEV_MODE,

    // db
    dataDirectory:       dataDir,

    // blobstore (disk)
    blobstoreDiskLocation:    env.PDS_BLOBSTORE_DISK_LOCATION ?? `${dataDir}/blobs`,
    blobstoreDiskTmpLocation: env.PDS_BLOBSTORE_DISK_TMP_LOCATION,
    blobUploadLimit:          env.PDS_BLOB_UPLOAD_LIMIT,

    // identity
    didPlcUrl:             env.PDS_PLC_URL,
    plcRotationKey:        env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
    serviceHandleDomains:  env.PDS_SERVICE_HANDLE_DOMAINS,

    // actor store
    actorStoreCacheSize:  env.PDS_ACTOR_STORE_CACHE_SIZE,

    // invites — always off for a personal PDS
    inviteRequired: false,

    // email — optional
    ...(env.PDS_EMAIL_SMTP_URL && env.PDS_EMAIL_FROM_ADDRESS
      ? { emailSmtpUrl: env.PDS_EMAIL_SMTP_URL, emailFromAddress: env.PDS_EMAIL_FROM_ADDRESS }
      : {}),

    // crawlers — opt-in only; empty array = no announcements
    crawlers: env.PDS_CRAWLERS ?? [],

    // Bluesky infra — intentionally absent unless the user explicitly sets
    // these via process.env (the @atproto/pds envToCfg() will pick them up
    // through the raw env if ever needed, but we don't default to them).
  }
}

import path from 'node:path'
import { EnvSchema, type MoonstoneEnv } from './env.js'

// ---------------------------------------------------------------------------
// Config types
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
  db: {
    directory: string
  }
  blobstore: {
    location: string
    tempLocation?: string
  }
  identity: {
    plcUrl: string
    serviceHandleDomains: string[]
    plcRotationKeyHex?: string
  }
  crawlers: string[]
  invites: { required: false }
}

// ---------------------------------------------------------------------------
// Parsing
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
  const dataDir = env.PDS_DATA_DIRECTORY
  const hostname = env.PDS_HOSTNAME
  const port = env.PDS_PORT
  const publicUrl = hostname === 'localhost'
    ? `http://localhost:${port}`
    : `https://${hostname}`
  const did = env.PDS_SERVICE_DID ?? `did:web:${hostname}`

  const serviceHandleDomains =
    env.PDS_SERVICE_HANDLE_DOMAINS ?? [`.${hostname}`]

  return {
    service: {
      port,
      hostname,
      publicUrl,
      did,
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
      serviceHandleDomains,
      plcRotationKeyHex: env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
    },
    crawlers: env.PDS_CRAWLERS,
    invites: { required: false },
  }
}

// ---------------------------------------------------------------------------
// Bridge: MoonstoneEnv → @atproto/pds ServerEnvironment
// ---------------------------------------------------------------------------
// readEnv() from @atproto/pds reads process.env directly. To avoid re-parsing
// from scratch we build the ServerEnvironment object matching its shape.
// This keeps us decoupled from @atproto/pds internals while still delegating
// the heavy lifting of envToCfg() / envToSecrets() to the official package.

export function toAtprotoEnv(env: MoonstoneEnv) {
  return {
    // service
    port: env.PDS_PORT,
    hostname: env.PDS_HOSTNAME,
    serviceDid: env.PDS_SERVICE_DID,
    version: env.PDS_VERSION,
    devMode: env.PDS_DEV_MODE,
    blobUploadLimit: env.PDS_BLOB_UPLOAD_LIMIT,

    // db — all in data directory
    dataDirectory: env.PDS_DATA_DIRECTORY,

    // blobstore — disk only
    blobstoreDiskLocation:
      env.PDS_BLOBSTORE_DISK_LOCATION ??
      `${env.PDS_DATA_DIRECTORY}/blobs`,
    blobstoreDiskTmpLocation: env.PDS_BLOBSTORE_DISK_TMP_LOCATION,

    // identity
    didPlcUrl: env.PDS_PLC_URL,
    plcRotationKey: env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
    serviceHandleDomains: env.PDS_SERVICE_HANDLE_DOMAINS,

    // actor store
    actorStoreCacheSize: env.PDS_ACTOR_STORE_CACHE_SIZE,

    // invites — always off for personal PDS
    inviteRequired: false,

    // crawlers
    crawlers: env.PDS_CRAWLERS,

    // no Redis, no email, no mod service, no appview
  }
}

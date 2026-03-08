import path from 'node:path'
import { EnvSchema, type MoonstoneEnv } from './env.js'

// ---------------------------------------------------------------------------
// Exported config shape
// ---------------------------------------------------------------------------

export type MoonstoneConfig = {
  // Configured AppView for proxying app.bsky.* and other unhandled XRPC.
  // null = no proxy; 501 for unknown methods.
  appView: { url: string; did: string } | null
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

  // Canonical names take priority; fall back to deprecated Bluesky-branded aliases.
  const appViewUrl = env.PDS_APP_VIEW_URL ?? env.PDS_BSKY_APP_VIEW_URL
  const appViewDid = env.PDS_APP_VIEW_DID ?? env.PDS_BSKY_APP_VIEW_DID

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
    crawlers: env.PDS_CRAWLERS ?? [],
    appView: appViewUrl && appViewDid
      ? { url: appViewUrl, did: appViewDid }
      : null,
  }
}

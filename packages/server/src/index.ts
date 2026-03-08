import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { createHttpTerminator } from 'http-terminator'
import { parseEnv, buildConfig } from '@ewanc26/moonstone-config'
import { openDb } from './db/index.js'
import { buildAppContext } from './context.js'
import { validateStartup } from './validate.js'
import { mountRoutes } from './routes.js'
import { createXrpcOverrides } from './xrpc/index.js'
import { buildApiRouter, attachSubscribeRepos } from './api/index.js'
import { buildProxyHandler } from './proxy.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const env = parseEnv()
await validateStartup(env)

const cfg = {
  ...buildConfig(env),
  jwtSecret: env.PDS_JWT_SECRET,
  adminPassword: env.PDS_ADMIN_PASSWORD,
  blobsDir: env.PDS_BLOB_UPLOAD_LOCATION
    ?? path.join(env.PDS_DATA_DIRECTORY ?? 'data', 'blobs'),
  plcRotationKeyHex: env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
}

const db = openDb(cfg.db.directory)
const ctx = await buildAppContext(cfg, db)

// Start sequencer background poll
ctx.sequencer.start()

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))
// Raw body needed for blob uploads (uploadBlob, importRepo)
app.use('/xrpc/com.atproto.repo.uploadBlob', express.raw({ type: '*/*', limit: '100mb' }))
app.use('/xrpc/com.atproto.repo.importRepo', express.raw({ type: '*/*', limit: '200mb' }))

// 1. XRPC identity overrides (resolveDid, resolveIdentity, updateHandle, etc.)
app.use(createXrpcOverrides(ctx))

// 2. All XRPC routes (server + repo + sync + admin)
app.use(buildApiRouter(ctx))

// 3. Non-XRPC routes (/tls-check)
mountRoutes(app, ctx)

// 4. Health check
app.get('/xrpc/_health', (_req, res) => {
  res.json({ version: cfg.service.version ?? 'unknown' })
})

// 5. app.bsky.* + unknown XRPC → proxy to AppView (if configured)
app.use('/xrpc/', buildProxyHandler(ctx))

// 6. 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'Unknown method or endpoint' })
})

// ---------------------------------------------------------------------------
// HTTP server + WebSocket (subscribeRepos)
// ---------------------------------------------------------------------------

const server = http.createServer(app)
const terminator = createHttpTerminator({ server })

// Attach WS upgrade handler for com.atproto.sync.subscribeRepos
attachSubscribeRepos(server, ctx)

server.listen(cfg.service.port, () => {
  logger.info({ port: cfg.service.port, did: cfg.service.did }, 'moonstone PDS listening')
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'moonstone: shutting down')
  await ctx.sequencer.destroy()
  await terminator.terminate()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

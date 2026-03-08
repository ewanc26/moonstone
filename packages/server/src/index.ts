import http from 'node:http'
import express from 'express'
import { createHttpTerminator } from 'http-terminator'
import { parseEnv, buildConfig } from '@ewanc26/moonstone-config'
import { openDb } from './db/index.js'
import { buildAppContext } from './context.js'
import { validateStartup } from './validate.js'
import { mountRoutes } from './routes.js'
import { createXrpcOverrides } from './xrpc/index.js'
import { buildApiRouter } from './api/index.js'
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
}

const db = openDb(cfg.db.directory)
const ctx = buildAppContext(cfg, db)

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// 1. XRPC overrides (identity endpoints not in the base ATProto lexicon)
app.use(createXrpcOverrides(ctx))

// 2. Our own com.atproto.server.* implementation
app.use(buildApiRouter(ctx))

// 3. Non-XRPC routes (/tls-check etc.)
mountRoutes(app, ctx)

// 4. Health check (mirrors @atproto/pds /xrpc/_health)
app.get('/xrpc/_health', (_req, res) => {
  res.json({ version: cfg.service.version ?? 'unknown' })
})

// 5. Catch-all 404
app.use((_req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'Unknown method or endpoint' })
})

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(app)
const terminator = createHttpTerminator({ server })

server.listen(cfg.service.port, () => {
  logger.info({ port: cfg.service.port, did: cfg.service.did }, 'moonstone PDS listening')
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'moonstone: shutting down')
  await terminator.terminate()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

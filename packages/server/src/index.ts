import events from 'node:events'
import http from 'node:http'
import express from 'express'
import { createHttpTerminator } from 'http-terminator'
import { PDS, envToCfg, envToSecrets, httpLogger } from '@atproto/pds'
import { parseEnv, toAtprotoEnv } from '@ewanc26/moonstone-config'
import { mountRoutes } from './routes.js'
import { validateStartup } from './validate.js'
import { createXrpcOverrides } from './xrpc/index.js'

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse + validate env — fast-fail on missing/invalid config
  const moonstoneEnv = parseEnv(process.env)

  // 2. Startup validation using the Rust native addon (rsky-syntax +
  //    rsky-identity). Catches bad hostname/DID format before network calls.
  await validateStartup(moonstoneEnv)

  // 3. Build @atproto/pds config + secrets from our validated env
  const atprotoEnv = toAtprotoEnv(moonstoneEnv)
  const cfg = envToCfg(atprotoEnv as Parameters<typeof envToCfg>[0])
  const secrets = envToSecrets({
    jwtSecret: moonstoneEnv.PDS_JWT_SECRET,
    adminPassword: moonstoneEnv.PDS_ADMIN_PASSWORD,
    plcRotationKey: moonstoneEnv.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
  } as Parameters<typeof envToSecrets>[0])

  // 4. Create the upstream PDS instance — registers all standard @atproto/pds
  //    XRPC handlers on its internal router.
  const pds = await PDS.create(cfg, secrets)

  // 5. Mount extra HTTP routes directly onto pds.app. Currently: /tls-check.
  //    /xrpc/_health is already provided by @atproto/pds.
  mountRoutes(pds)

  // 6. Wrap pds.app with our XRPC override layer so that lexicon endpoints not
  //    handled by @atproto/pds (resolveDid, resolveIdentity, refreshIdentity)
  //    are served before the upstream router gets a chance to proxy them.
  const wrapper = express()
  wrapper.use(createXrpcOverrides(pds.ctx))
  wrapper.use(pds.app)

  // 7. Manual HTTP lifecycle — mirrors PDS.start() but uses wrapper instead of
  //    pds.app so XRPC overrides are served from the same port.
  await pds.ctx.sequencer.start()

  const httpServer = http.createServer(wrapper)
  const terminator = createHttpTerminator({ server: httpServer })
  httpServer.keepAliveTimeout = 90000
  httpServer.listen(cfg.service.port)
  await events.once(httpServer, 'listening')

  httpLogger.info(
    {
      hostname: cfg.service.hostname,
      port: cfg.service.port,
      did: cfg.service.did,
      plcUrl: cfg.identity.plcUrl,
      bskyAppView: cfg.bskyAppView?.url ?? null,
      crawlers: cfg.crawlers ?? [],
    },
    'moonstone started',
  )

  // 8. Graceful shutdown — replicates PDS.destroy() directly since we own the
  //    HTTP server and terminator (pds.start() was never called).
  const shutdown = async () => {
    httpLogger.info('moonstone shutting down')
    await pds.ctx.sequencer.destroy()
    await terminator.terminate()
    await pds.ctx.backgroundQueue.destroy()
    await pds.ctx.accountManager.close()
    await pds.ctx.redisScratch?.quit()
    await pds.ctx.proxyAgent.destroy()
    httpLogger.info('moonstone stopped')
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err: unknown) => {
  console.error('moonstone fatal error:', err)
  process.exit(1)
})

import {
  PDS,
  envToCfg,
  envToSecrets,
  httpLogger,
} from '@atproto/pds'
import { parseEnv, toAtprotoEnv } from '@ewanc26/moonstone-config'
import { mountRoutes } from './routes.js'
import { validateStartup } from './validate.js'

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse + validate env — fast-fail on missing/invalid config
  const moonstoneEnv = parseEnv(process.env)

  // 2. Run startup validation using the Rust native addon (rsky-syntax +
  //    rsky-identity). This catches bad hostname/DID format before the PDS
  //    attempts any network calls.
  await validateStartup(moonstoneEnv)

  // 3. Build @atproto/pds config + secrets from our validated env
  const atprotoEnv = toAtprotoEnv(moonstoneEnv)
  const cfg = envToCfg(atprotoEnv as Parameters<typeof envToCfg>[0])
  const secrets = envToSecrets({
    jwtSecret: moonstoneEnv.PDS_JWT_SECRET,
    adminPassword: moonstoneEnv.PDS_ADMIN_PASSWORD,
    plcRotationKey: moonstoneEnv.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
  } as Parameters<typeof envToSecrets>[0])

  // 4. Create + mount extra routes + start
  const pds = await PDS.create(cfg, secrets)
  mountRoutes(pds)
  await pds.start()

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

  // 5. Graceful shutdown (systemd SIGTERM / NixOS service stop)
  const shutdown = async () => {
    httpLogger.info('moonstone shutting down')
    await pds.destroy()
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

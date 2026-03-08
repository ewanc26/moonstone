import {
  PDS,
  envToCfg,
  envToSecrets,
  httpLogger,
} from '@atproto/pds'
import { parseEnv, toAtprotoEnv } from '@moonstone/config'
import { mountRoutes } from './routes.js'

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse + validate env (fast-fail on missing secrets)
  const moonstoneEnv = parseEnv(process.env)

  // 2. Bridge to @atproto/pds's config/secrets shapes
  const atprotoEnv = toAtprotoEnv(moonstoneEnv)
  const cfg = envToCfg(atprotoEnv as Parameters<typeof envToCfg>[0])
  const secrets = envToSecrets({
    jwtSecret: moonstoneEnv.PDS_JWT_SECRET,
    adminPassword: moonstoneEnv.PDS_ADMIN_PASSWORD,
    plcRotationKey: moonstoneEnv.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
  } as Parameters<typeof envToSecrets>[0])

  // 3. Create + start
  const pds = await PDS.create(cfg, secrets)
  mountRoutes(pds)
  await pds.start()

  httpLogger.info(
    {
      hostname: cfg.service.hostname,
      port: cfg.service.port,
      did: cfg.service.did,
    },
    'moonstone started',
  )

  // 4. Graceful shutdown (systemd SIGTERM / NixOS service stop)
  process.on('SIGTERM', async () => {
    httpLogger.info('moonstone shutting down')
    await pds.destroy()
    httpLogger.info('moonstone stopped')
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    await pds.destroy()
    process.exit(0)
  })
}

main().catch((err: unknown) => {
  console.error('moonstone fatal error', err)
  process.exit(1)
})

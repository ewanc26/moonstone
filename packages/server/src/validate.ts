import type { MoonstoneEnv } from '@ewanc26/moonstone-config'
import { logger } from './logger.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type NativeAddon = {
  ensureValidHandle(handle: string): void
  ensureValidDid(did: string): void
  resolveDid(did: string, plcUrl: string, timeoutMs: number): Promise<Record<string, unknown> | null>
}

function loadNative(): NativeAddon | null {
  try {
    return require('@ewanc26/moonstone-native') as NativeAddon
  } catch {
    logger.warn(
      'moonstone-native addon not built — skipping Rust-backed startup validation. ' +
      'Run `pnpm --filter @ewanc26/moonstone-native build` to enable.',
    )
    return null
  }
}

export async function validateStartup(env: MoonstoneEnv): Promise<void> {
  const native = loadNative()
  if (!native) return

  const hostname = env.PDS_HOSTNAME
  const did = env.PDS_SERVICE_DID ?? `did:web:${hostname}`
  const plcUrl = env.PDS_PLC_URL
  const devMode = env.PDS_DEV_MODE

  try {
    native.ensureValidHandle(hostname)
  } catch (e) {
    throw new Error(`PDS_HOSTNAME "${hostname}" is not a valid ATProto handle: ${(e as Error).message}`)
  }

  try {
    native.ensureValidDid(did)
  } catch (e) {
    throw new Error(`Service DID "${did}" is invalid: ${(e as Error).message}`)
  }

  if (!devMode) {
    logger.info({ did, plcUrl }, 'moonstone: resolving PDS DID document for pre-flight check')
    try {
      const doc = await native.resolveDid(did, plcUrl, 5000)
      if (doc) {
        logger.info({ did }, 'moonstone: DID document found')
      } else {
        logger.warn({ did, plcUrl }, 'moonstone: DID document not yet registered — expected for first-time setup')
      }
    } catch (e) {
      logger.warn({ did, err: (e as Error).message }, 'moonstone: DID resolution failed during startup — continuing anyway')
    }
  }

  logger.info({ hostname, did }, 'moonstone: startup validation passed')
}

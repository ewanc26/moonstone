import type { MoonstoneEnv } from '@moonstone/config'
import { httpLogger } from '@atproto/pds'
import { createRequire } from 'node:module'

// The native addon is CommonJS (neon constraint), so we load it via createRequire.
const require = createRequire(import.meta.url)

type NativeAddon = {
  ensureValidHandle(handle: string): void
  ensureValidDid(did: string): void
  resolveDid(did: string, plcUrl: string, timeoutMs: number): Promise<Record<string, unknown> | null>
}

function loadNative(): NativeAddon | null {
  try {
    // Resolved relative to @moonstone/native package root
    return require('@moonstone/native') as NativeAddon
  } catch {
    httpLogger.warn(
      'moonstone-native addon not built — skipping Rust-backed startup validation. ' +
      'Run `pnpm --filter @moonstone/native build` to enable.',
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
// Uses the Rust native addon (rsky-syntax + rsky-identity) to:
//  1. Validate PDS_HOSTNAME as an ATProto handle
//  2. Validate the derived service DID
//  3. Optionally verify the PDS's own DID document is reachable
//     (skipped if PDS_DEV_MODE=true to allow localhost dev setups)

export async function validateStartup(env: MoonstoneEnv): Promise<void> {
  const native = loadNative()
  if (!native) return

  const hostname = env.PDS_HOSTNAME
  const did = env.PDS_SERVICE_DID ?? `did:web:${hostname}`
  const plcUrl = env.PDS_PLC_URL
  const devMode = env.PDS_DEV_MODE

  // 1. Syntax check the hostname as a handle
  try {
    native.ensureValidHandle(hostname)
  } catch (e) {
    throw new Error(`PDS_HOSTNAME "${hostname}" is not a valid ATProto handle: ${(e as Error).message}`)
  }

  // 2. Syntax check the service DID
  try {
    native.ensureValidDid(did)
  } catch (e) {
    throw new Error(`Service DID "${did}" is invalid: ${(e as Error).message}`)
  }

  // 3. In non-dev mode, attempt to resolve the DID document to catch misconfig
  //    before the PDS tries to register with the PLC directory.
  if (!devMode) {
    httpLogger.info({ did, plcUrl }, 'moonstone: resolving PDS DID document for pre-flight check')
    try {
      const doc = await native.resolveDid(did, plcUrl, 5000)
      if (doc) {
        httpLogger.info({ did }, 'moonstone: DID document found')
      } else {
        // Not found is expected for a brand-new PDS — warn but don't abort.
        httpLogger.warn(
          { did, plcUrl },
          'moonstone: DID document not yet registered — expected for first-time setup',
        )
      }
    } catch (e) {
      httpLogger.warn(
        { did, err: (e as Error).message },
        'moonstone: DID resolution failed during startup — continuing anyway',
      )
    }
  }

  httpLogger.info({ hostname, did }, 'moonstone: startup validation passed')
}

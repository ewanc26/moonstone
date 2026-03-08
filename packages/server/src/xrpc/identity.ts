import { Router } from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'

// Attempt to import the native addon at startup; fall back gracefully.
let native: typeof import('@ewanc26/moonstone-native') | null = null
try {
  native = await import('@ewanc26/moonstone-native')
} catch {
  // native addon not built — use JS fallback
}

export function createIdentityOverrides(ctx: AppContext): Router {
  const router = Router()
  const plcUrl = ctx.cfg.identity.plcUrl

  // ── com.atproto.identity.resolveDid ─────────────────────────────────
  router.get('/xrpc/com.atproto.identity.resolveDid', async (req, res) => {
    const did = req.query.did as string | undefined
    if (!did) return res.status(400).json({ error: 'InvalidRequest', message: 'did is required' })
    try {
      let didDoc: Record<string, unknown> | null = null
      if (native) {
        didDoc = await native.resolveDid(did, plcUrl, 5000)
      } else {
        didDoc = await ctx.idResolver.did.resolve(did)
      }
      if (!didDoc) return res.status(404).json({ error: 'NotFound', message: `DID not found: ${did}` })
      res.json({ didDoc })
    } catch (err) {
      res.status(500).json({ error: 'InternalServerError', message: String(err) })
    }
  })

  // ── com.atproto.identity.resolveIdentity ─────────────────────────────
  router.get('/xrpc/com.atproto.identity.resolveIdentity', async (req, res) => {
    const identity = req.query.identity as string | undefined
    if (!identity) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'identity is required' })
    }
    try {
      let did: string
      let didDoc: Record<string, unknown> | null

      if (identity.startsWith('did:')) {
        did = identity
        didDoc = native
          ? await native.resolveDid(did, plcUrl, 5000)
          : await ctx.idResolver.did.resolve(did)
      } else {
        // handle -> DID
        const resolved = native
          ? await native.resolveHandle(identity, 5000)
          : await ctx.idResolver.handle.resolve(identity)
        if (!resolved) {
          return res.status(404).json({ error: 'NotFound', message: `Handle not found: ${identity}` })
        }
        did = resolved
        didDoc = native
          ? await native.resolveDid(did, plcUrl, 5000)
          : await ctx.idResolver.did.resolve(did)
      }

      if (!didDoc) {
        return res.status(404).json({ error: 'NotFound', message: `DID document not found for: ${did}` })
      }

      // Extract handle from DID doc
      const handle = extractHandleFromDoc(didDoc) ?? (identity.startsWith('did:') ? null : identity)

      res.json({ did, handle, didDoc })
    } catch (err) {
      res.status(500).json({ error: 'InternalServerError', message: String(err) })
    }
  })

  // ── com.atproto.identity.refreshIdentity ─────────────────────────────
  router.post('/xrpc/com.atproto.identity.refreshIdentity', async (req, res) => {
    const did = req.body?.did as string | undefined
    if (!did) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'did is required' })
    }
    try {
      const didDoc = native
        ? await native.resolveDid(did, plcUrl, 5000)
        : await ctx.idResolver.did.resolve(did, true) // forceRefresh

      if (!didDoc) {
        return res.status(404).json({ error: 'NotFound', message: `DID not found: ${did}` })
      }

      const handle = extractHandleFromDoc(didDoc)
      res.json({ did, handle, didDoc })
    } catch (err) {
      res.status(500).json({ error: 'InternalServerError', message: String(err) })
    }
  })

  return router
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHandleFromDoc(doc: Record<string, unknown>): string | null {
  const aka = (doc as any).alsoKnownAs
  if (!Array.isArray(aka)) return null
  const atUri = (aka as string[]).find((u) => u.startsWith('at://'))
  return atUri ? atUri.slice(5) : null
}

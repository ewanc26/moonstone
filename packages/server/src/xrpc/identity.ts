import { Router } from 'express'
import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { updatePlcHandle, signPlcOp } from '../api/com/atproto/admin/plc-util.js'
import { logger } from '../logger.js'

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
        : await ctx.idResolver.did.resolve(did, true)

      if (!didDoc) {
        return res.status(404).json({ error: 'NotFound', message: `DID not found: ${did}` })
      }

      const handle = extractHandleFromDoc(didDoc)
      res.json({ did, handle, didDoc })
    } catch (err) {
      res.status(500).json({ error: 'InternalServerError', message: String(err) })
    }
  })

  // ── com.atproto.identity.updateHandle ─────────────────────────────────
  router.post('/xrpc/com.atproto.identity.updateHandle',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const requesterDid = res.locals.auth.credentials.did
        const { handle } = req.body ?? {}
        if (!handle) throw new InvalidRequestError('handle is required')

        const normalized = ctx.accountManager.normalizeAndValidateHandle(handle, { did: requesterDid })

        // Check handle availability
        const existing = ctx.accountManager.getAccount(normalized, { includeDeactivated: true, includeTakenDown: true })
        if (existing && existing.did !== requesterDid) {
          throw new InvalidRequestError(`Handle already taken: ${normalized}`)
        }

        if (!existing) {
          // Update PLC doc for did:plc
          if (requesterDid.startsWith('did:plc:')) {
            try {
              await updatePlcHandle(ctx, requesterDid, normalized)
            } catch (err) {
              if (err instanceof InvalidRequestError) throw err
              logger.warn({ err, did: requesterDid }, 'identity.updateHandle: PLC update failed')
              throw new InvalidRequestError('Failed to update DID document for handle')
            }
          } else {
            // did:web — verify DNS/HTTP handle points to this DID
            const resolved = await ctx.idResolver.handle.resolve(normalized).catch(() => null)
            if (resolved !== requesterDid) {
              throw new InvalidRequestError('DID is not properly configured for handle')
            }
          }
          ctx.accountManager.updateHandle(requesterDid, normalized)
        }

        try {
          await ctx.sequencer.sequenceIdentityEvt(requesterDid, normalized)
        } catch (err) {
          logger.error({ err, did: requesterDid, handle: normalized }, 'failed to sequence handle update')
        }

        res.status(200).end()
      } catch (err) {
        if (err instanceof InvalidRequestError) {
          return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
        }
        if (err instanceof AuthRequiredError) {
          return res.status(401).json({ error: err.error ?? 'AuthRequired', message: err.message })
        }
        res.status(500).json({ error: 'InternalServerError', message: String(err) })
      }
    },
  )

  // ── com.atproto.identity.requestPlcOperationSignature ─────────────────
  router.post('/xrpc/com.atproto.identity.requestPlcOperationSignature',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
        const did = res.locals.auth.credentials.did
        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
        if (!account) throw new InvalidRequestError('account not found')
        if (!account.email) throw new InvalidRequestError('account does not have an email address')
        const token = ctx.accountManager.createEmailToken(did, 'plc_operation')
        await ctx.mailer.sendPlcOperation({ token }, { to: account.email })
        res.status(200).end()
      } catch (err) {
        if (err instanceof InvalidRequestError) {
          return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
        }
        res.status(500).json({ error: 'InternalServerError', message: String(err) })
      }
    },
  )

  // ── com.atproto.identity.signPlcOperation ─────────────────────────────
  router.post('/xrpc/com.atproto.identity.signPlcOperation',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { token, rotationKeys, alsoKnownAs, verificationMethods, services } = req.body ?? {}

        if (!token) {
          throw new InvalidRequestError('email confirmation token required to sign PLC operations')
        }
        ctx.accountManager.assertValidEmailToken(did, 'plc_operation', token)
        ctx.accountManager.deleteEmailToken(did, 'plc_operation')

        const operation = await signPlcOp(ctx, did, {
          rotationKeys, alsoKnownAs, verificationMethods, services,
        })

        res.json({ operation })
      } catch (err) {
        if (err instanceof InvalidRequestError) {
          return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
        }
        res.status(500).json({ error: 'InternalServerError', message: String(err) })
      }
    },
  )

  // ── com.atproto.identity.submitPlcOperation ───────────────────────────
  router.post('/xrpc/com.atproto.identity.submitPlcOperation',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { operation } = req.body ?? {}
        if (!operation) throw new InvalidRequestError('operation is required')

        const sendResp = await fetch(`${plcUrl}/${did}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(operation),
          signal: AbortSignal.timeout(10_000),
        })
        if (!sendResp.ok) {
          throw new InvalidRequestError(`PLC operation rejected: ${await sendResp.text()}`)
        }
        res.status(200).end()
      } catch (err) {
        if (err instanceof InvalidRequestError) {
          return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
        }
        res.status(500).json({ error: 'InternalServerError', message: String(err) })
      }
    },
  )

  // ── com.atproto.identity.getRecommendedDidCredentials ─────────────────
  router.get('/xrpc/com.atproto.identity.getRecommendedDidCredentials',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        res.json({
          rotationKeys: [ctx.plcRotationKey.did()],
          alsoKnownAs: [],
          verificationMethods: { atproto: signingKey.did() },
          services: {
            atproto_pds: {
              type: 'AtprotoPersonalDataServer',
              endpoint: ctx.cfg.service.publicUrl,
            },
          },
        })
      } catch (err) {
        res.status(500).json({ error: 'InternalServerError', message: String(err) })
      }
    },
  )

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

/**
 * com.atproto.identity overrides for moonstone
 *
 * Implements three lexicon endpoints that @atproto/pds does not register:
 *
 *   GET  /xrpc/com.atproto.identity.resolveDid
 *   GET  /xrpc/com.atproto.identity.resolveIdentity
 *   POST /xrpc/com.atproto.identity.refreshIdentity
 *
 * Each is backed by the @ewanc26/moonstone-native Rust addon (rsky-identity)
 * when available, with automatic fallback to the @atproto/identity IdResolver
 * that is already wired into AppContext.
 *
 * Output shape follows the lexicon types generated in @atproto/pds:
 *   resolveDid       → { didDoc }
 *   resolveIdentity  → { did, handle, didDoc }   (com.atproto.identity.defs#identityInfo)
 *   refreshIdentity  → { did, handle, didDoc }   (same)
 */

import type { AppContext } from '@atproto/pds'
import { httpLogger } from '@atproto/pds'
import { INVALID_HANDLE } from '@atproto/syntax'
import { Router, type Request, type Response } from 'express'
import { createRequire } from 'node:module'

// ---------------------------------------------------------------------------
// Native addon
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url)

type NativeAddon = {
  resolveDid(did: string, plcUrl: string, timeoutMs: number): Promise<Record<string, unknown> | null>
  resolveHandle(handle: string, timeoutMs: number): Promise<string | null>
}

function loadNative(): NativeAddon | null {
  try {
    return _require('@ewanc26/moonstone-native') as NativeAddon
  } catch {
    httpLogger.warn(
      'moonstone-native: addon not built — identity XRPC endpoints fall back to idResolver',
    )
    return null
  }
}

const native = loadNative()

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

async function resolveDidDoc(
  ctx: AppContext,
  did: string,
): Promise<Record<string, unknown> | null> {
  if (native) {
    return native.resolveDid(did, ctx.cfg.identity.plcUrl, 5000)
  }
  return ctx.idResolver.did.resolve(did) as Promise<Record<string, unknown> | null>
}

async function resolveHandleToDid(ctx: AppContext, handle: string): Promise<string | null> {
  if (native) {
    return native.resolveHandle(handle, 5000)
  }
  return ctx.idResolver.handle.resolve(handle)
}

/**
 * Extract the ATProto handle from the `alsoKnownAs` array of a DID document.
 * Returns INVALID_HANDLE if none is present.
 */
function extractHandle(didDoc: Record<string, unknown>): string {
  const aka = didDoc['alsoKnownAs']
  if (!Array.isArray(aka)) return INVALID_HANDLE
  const atUri = aka.find((u): u is string => typeof u === 'string' && u.startsWith('at://'))
  return atUri ? atUri.slice('at://'.length) : INVALID_HANDLE
}

/**
 * Bi-directionally verify the handle embedded in a DID document.
 * Returns INVALID_HANDLE if verification fails or no handle is present.
 */
async function verifiedHandle(
  ctx: AppContext,
  did: string,
  didDoc: Record<string, unknown>,
): Promise<string> {
  const handle = extractHandle(didDoc)
  if (handle === INVALID_HANDLE) return INVALID_HANDLE
  try {
    const resolvedDid = await resolveHandleToDid(ctx, handle)
    return resolvedDid === did ? handle : INVALID_HANDLE
  } catch {
    return INVALID_HANDLE
  }
}

// ---------------------------------------------------------------------------
// Shared resolution flow used by resolveIdentity + refreshIdentity
// ---------------------------------------------------------------------------

async function resolveIdentityForIdentifier(
  ctx: AppContext,
  identifier: string,
  res: Response,
) {
  let did: string
  let didDoc: Record<string, unknown> | null

  if (identifier.startsWith('did:')) {
    did = identifier
    didDoc = await resolveDidDoc(ctx, did)
  } else {
    const resolvedDid = await resolveHandleToDid(ctx, identifier)
    if (!resolvedDid) {
      return xrpcError(res, 400, 'HandleNotFound', `Handle did not resolve to a DID: ${identifier}`)
    }
    did = resolvedDid
    didDoc = await resolveDidDoc(ctx, did)
  }

  if (!didDoc) {
    return xrpcError(res, 400, 'DidNotFound', `DID not found: ${did}`)
  }

  const handle = await verifiedHandle(ctx, did, didDoc)
  return res.json({ did, handle, didDoc })
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function xrpcError(res: Response, status: number, error: string, message: string) {
  return res.status(status).json({ error, message })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createIdentityOverrides(ctx: AppContext): Router {
  const router = Router()

  // ── GET com.atproto.identity.resolveDid ─────────────────────────────────
  // Resolves a DID to its DID document. No handle verification.
  router.get('/xrpc/com.atproto.identity.resolveDid', async (req: Request, res: Response) => {
    const { did } = req.query
    if (!did || typeof did !== 'string') {
      return xrpcError(res, 400, 'InvalidRequest', 'missing required param: did')
    }
    if (!did.startsWith('did:')) {
      return xrpcError(res, 400, 'InvalidRequest', `not a valid DID: ${did}`)
    }
    try {
      const didDoc = await resolveDidDoc(ctx, did)
      if (!didDoc) {
        return xrpcError(res, 400, 'DidNotFound', `DID not found: ${did}`)
      }
      return res.json({ didDoc })
    } catch (err) {
      httpLogger.error({ err, did }, 'com.atproto.identity.resolveDid failed')
      return xrpcError(res, 500, 'InternalServerError', 'failed to resolve DID')
    }
  })

  // ── GET com.atproto.identity.resolveIdentity ─────────────────────────────
  // Resolves a handle or DID to a full identity (DID doc + verified handle).
  router.get(
    '/xrpc/com.atproto.identity.resolveIdentity',
    async (req: Request, res: Response) => {
      const { identifier } = req.query
      if (!identifier || typeof identifier !== 'string') {
        return xrpcError(res, 400, 'InvalidRequest', 'missing required param: identifier')
      }
      try {
        return await resolveIdentityForIdentifier(ctx, identifier, res)
      } catch (err) {
        httpLogger.error({ err, identifier }, 'com.atproto.identity.resolveIdentity failed')
        return xrpcError(res, 500, 'InternalServerError', 'failed to resolve identity')
      }
    },
  )

  // ── POST com.atproto.identity.refreshIdentity ────────────────────────────
  // Requests a fresh resolution, bypassing any cached state. Auth is optional
  // per the lexicon; moonstone honours the request for all callers.
  router.post(
    '/xrpc/com.atproto.identity.refreshIdentity',
    async (req: Request, res: Response) => {
      const body = req.body as { identifier?: unknown }
      const identifier = body?.identifier

      if (!identifier || typeof identifier !== 'string') {
        return xrpcError(res, 400, 'InvalidRequest', 'missing required field: identifier')
      }

      // Force-refresh the DID cache on the idResolver fallback path so stale
      // entries are not served. The native addon resolves fresh by default.
      if (identifier.startsWith('did:') && !native) {
        try {
          await ctx.idResolver.did.resolve(identifier, true)
        } catch {
          // Cache-bust is best-effort; resolution proceeds below regardless.
        }
      }

      try {
        return await resolveIdentityForIdentifier(ctx, identifier, res)
      } catch (err) {
        httpLogger.error({ err, identifier }, 'com.atproto.identity.refreshIdentity failed')
        return xrpcError(res, 500, 'InternalServerError', 'failed to refresh identity')
      }
    },
  )

  return router
}

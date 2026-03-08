/**
 * XRPC override layer for moonstone
 *
 * Returns an express Router that intercepts XRPC endpoints defined in the
 * ATProto lexicon but not implemented by @atproto/pds. Routes registered here
 * are checked before pds.app so that any unhandled lexicon method falls through
 * to the upstream PDS instead of hitting its proxy catchall.
 *
 * Current overrides:
 *   com.atproto.identity — resolveDid, resolveIdentity, refreshIdentity
 */

import type { AppContext } from '@atproto/pds'
import { Router } from 'express'
import { createIdentityOverrides } from './identity.js'

export function createXrpcOverrides(ctx: AppContext): Router {
  const router = Router()
  router.use(createIdentityOverrides(ctx))
  return router
}

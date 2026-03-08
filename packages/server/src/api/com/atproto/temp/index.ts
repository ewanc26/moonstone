/**
 * com.atproto.temp.* routes
 *
 * These are unspecced / transitional endpoints that Bluesky clients may call.
 * For a standalone personal PDS the sensible behaviour is:
 *   checkSignupQueue → { activated: true }   (no queue — always active)
 *
 * Additional temp.* endpoints can be added here as needed.
 */
import { Router } from 'express'
import type { AppContext } from '../../../../context.js'

export function mountTempRoutes(router: Router, ctx: AppContext) {

  // ── checkSignupQueue ─────────────────────────────────────────────────────
  // Clients (including the official Bluesky app) call this after login to
  // check whether the account has cleared a signup queue.  A personal PDS
  // has no queue, so we always respond with { activated: true }.
  router.get('/xrpc/com.atproto.temp.checkSignupQueue',
    ctx.authVerifier.accessToken,
    async (_req, res) => {
      res.json({ activated: true })
    },
  )

  // ── requestPhoneVerification ─────────────────────────────────────────────
  // Bluesky-specific, not relevant for personal PDS — return a stub 200 to
  // prevent hard errors in clients that speculatively call this.
  router.post('/xrpc/com.atproto.temp.requestPhoneVerification',
    ctx.authVerifier.accessToken,
    async (_req, res) => {
      res.status(200).end()
    },
  )
}

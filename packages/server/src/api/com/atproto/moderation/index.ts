/**
 * com.atproto.moderation.* routes
 *
 * createReport: proxies to a configured moderation service (ozone / bsky mod)
 * via service-auth JWT.  If no moderation service is configured for this PDS,
 * the endpoint still accepts the request (so Bluesky clients don't error) but
 * returns a stub response — personal PDS operators typically don't run their
 * own moderation infrastructure.
 */
import { Router, Response } from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { logger } from '../../../../logger.js'

function xErr(res: Response, err: unknown) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
  }
  logger.error({ err }, 'moderation handler error')
  return res.status(500).json({ error: 'InternalServerError', message: String(err) })
}

export function mountModerationRoutes(router: Router, ctx: AppContext) {

  // ── createReport ────────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.moderation.createReport',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const reporterDid = res.locals.auth.credentials.did
        const { reasonType, reason, subject } = req.body ?? {}

        if (!subject) throw new InvalidRequestError('subject is required')

        // If a moderation / ozone service URL is configured, proxy to it.
        const modUrl = (ctx.cfg as any).moderationServiceUrl as string | undefined
        const modDid = (ctx.cfg as any).moderationServiceDid as string | undefined

        if (modUrl && modDid) {
          // Build service-auth JWT for the moderation service.
          const { createServiceJwt } = await import('@atproto/xrpc-server')
          const signingKey = await ctx.keyStore.getOrCreateKeypair(reporterDid)
          const jwt = await createServiceJwt({
            iss: reporterDid,
            aud: modDid,
            lxm: 'com.atproto.moderation.createReport',
            keypair: signingKey,
            exp: Math.floor(Date.now() / 1000) + 60,
          })

          const upstream = await fetch(
            `${modUrl}/xrpc/com.atproto.moderation.createReport`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${jwt}`,
              },
              body: JSON.stringify(req.body),
              signal: AbortSignal.timeout(15_000),
            },
          )
          if (!upstream.ok) {
            const body = await upstream.text()
            logger.warn({ status: upstream.status, body }, 'moderation service rejected report')
            return res.status(upstream.status).send(body)
          }
          const data = await upstream.json()
          return res.json(data)
        }

        // No moderation service configured — return a stub 201 so clients
        // don't error.  The report is silently discarded.
        logger.debug({ reporterDid, reasonType, subject }, 'report accepted (no moderation service configured)')
        return res.status(201).json({
          id: Date.now(),
          reasonType: reasonType ?? 'com.atproto.moderation.defs#reasonOther',
          subject,
          reportedBy: reporterDid,
          createdAt: new Date().toISOString(),
        })
      } catch (err) {
        xErr(res, err)
      }
    },
  )
}

import type { PDS } from '@atproto/pds'
import type { Request, Response } from 'express'
import { httpLogger } from '@atproto/pds'

// ---------------------------------------------------------------------------
// Extra HTTP routes
// ---------------------------------------------------------------------------

export function mountRoutes(pds: PDS): void {
  // /tls-check — required by goat tooling and Bluesky-compatible crawlers.
  // Mirrors the implementation from github.com/bluesky-social/pds exactly so
  // that crawlers can verify handle domains hosted on this PDS.
  pds.app.get('/tls-check', async (req: Request, res: Response) => {
    try {
      const { domain } = req.query
      if (!domain || typeof domain !== 'string') {
        return res
          .status(400)
          .json({ error: 'InvalidRequest', message: 'bad or missing domain query param' })
      }

      if (domain === pds.ctx.cfg.service.hostname) {
        return res.json({ success: true })
      }

      const isHostedHandle = pds.ctx.cfg.identity.serviceHandleDomains.find(
        (avail) => domain.endsWith(avail),
      )
      if (!isHostedHandle) {
        return res
          .status(400)
          .json({ error: 'InvalidRequest', message: 'handles are not provided on this domain' })
      }

      const account = await pds.ctx.accountManager.getAccount(domain)
      if (!account) {
        return res
          .status(404)
          .json({ error: 'NotFound', message: 'handle not found for this domain' })
      }

      return res.json({ success: true })
    } catch (err) {
      httpLogger.error({ err }, 'tls-check failed')
      return res
        .status(500)
        .json({ error: 'InternalServerError', message: 'Internal Server Error' })
    }
  })
}

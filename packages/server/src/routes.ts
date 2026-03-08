import type { PDS } from '@atproto/pds'
import type { Request, Response } from 'express'
import { httpLogger } from '@atproto/pds'

// ---------------------------------------------------------------------------
// Extra routes mounted on the PDS express app
// ---------------------------------------------------------------------------

export function mountRoutes(pds: PDS): void {
  // Health — used by systemd watchdog / Caddy health checks
  pds.app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: pds.ctx.cfg.service.version ?? 'unknown',
      hostname: pds.ctx.cfg.service.hostname,
    })
  })

  // Handle / TLS check — required by Bluesky crawlers and goat tooling
  pds.app.get('/tls-check', async (req: Request, res: Response) => {
    try {
      const { domain } = req.query
      if (!domain || typeof domain !== 'string') {
        return res
          .status(400)
          .json({ error: 'InvalidRequest', message: 'missing domain param' })
      }

      if (domain === pds.ctx.cfg.service.hostname) {
        return res.json({ success: true })
      }

      const isHandleDomain = pds.ctx.cfg.identity.serviceHandleDomains.find(
        (d) => domain.endsWith(d),
      )
      if (!isHandleDomain) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'handles not served on this domain',
        })
      }

      const account = await pds.ctx.accountManager.getAccount(domain)
      if (!account) {
        return res
          .status(404)
          .json({ error: 'NotFound', message: 'handle not found' })
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

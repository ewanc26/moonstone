import { Application } from 'express'
import tls from 'node:tls'
import https from 'node:https'
import type { AppContext } from './context.js'

/**
 * Mount non-XRPC routes that are not covered by the ATProto lexicons.
 * Currently: /tls-check (mirrors the official pds-main implementation).
 */
export function mountRoutes(app: Application, ctx: AppContext) {
  app.get('/tls-check', (_req, res) => {
    const hostname = ctx.cfg.service.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return res.json({ hostname, tlsVersion: 'n/a (localhost)' })
    }
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
      const info = {
        hostname,
        tlsVersion: socket.getProtocol() ?? 'unknown',
      }
      socket.destroy()
      res.json(info)
    })
    socket.on('error', (err) => {
      res.status(500).json({ error: 'TLS check failed', message: String(err) })
    })
  })
}

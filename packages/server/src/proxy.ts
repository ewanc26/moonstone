/**
 * AppView proxy — forwards unhandled XRPC calls (primarily app.bsky.*)
 * to a configured Bluesky AppView, attaching a service-auth JWT.
 *
 * Uses the `atproto-proxy` header to override the target (did#serviceId).
 * Falls back to the configured bskyAppView.
 */
import { Request, Response, NextFunction } from 'express'
import * as jose from 'jose'
import type { AppContext } from './context.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Service-auth JWT helper
// ---------------------------------------------------------------------------

async function makeServiceAuthJwt(
  ctx: AppContext,
  iss: string,
  aud: string,
  lxm: string,
): Promise<string> {
  const signingKey = await ctx.keyStore.getOrCreateKeypair(iss)
  // Build a compact JWS
  const { createServiceJwt } = await import('@atproto/xrpc-server')
  return createServiceJwt({
    iss,
    aud,
    lxm,
    keypair: signingKey,
    exp: Math.floor(Date.now() / 1000) + 60,
  })
}

// ---------------------------------------------------------------------------
// Proxy target resolution
// ---------------------------------------------------------------------------

type ProxyTarget = { url: string; did: string }

async function resolveProxyTarget(
  ctx: AppContext,
  req: Request,
  lxm: string,
): Promise<ProxyTarget | null> {
  // 1. Honour `atproto-proxy: did#serviceId` header
  const proxyHeader = req.headers['atproto-proxy'] as string | undefined
  if (proxyHeader) {
    const hashIdx = proxyHeader.indexOf('#')
    if (hashIdx < 1 || hashIdx === proxyHeader.length - 1) return null
    const did = proxyHeader.slice(0, hashIdx)
    // Short-circuit if it's our known AppView
    if (
      ctx.cfg.appView &&
      proxyHeader === `${ctx.cfg.appView.did}#bsky_appview`
    ) {
      return { url: ctx.cfg.appView.url, did }
    }
    // Resolve via DID doc
    try {
      const doc = await ctx.idResolver.did.resolve(did)
      if (!doc) return null
      const serviceId = proxyHeader.slice(hashIdx)
      const svc = (doc as any)['service']?.find?.(
        (s: any) => s.id === serviceId || s.id === did + serviceId,
      )
      if (!svc?.serviceEndpoint) return null
      return { url: svc.serviceEndpoint as string, did }
    } catch {
      return null
    }
  }

  // 2. Fall back to configured AppView for app.bsky.* and friends
  if (ctx.cfg.appView) {
    return ctx.cfg.appView
  }

  return null
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
])

const SAFE_FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST'])

export function buildProxyHandler(ctx: AppContext) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only proxy XRPC paths
    const lxm = req.path.replace(/^\//, '') // strip leading slash (path under /xrpc/)

    if (!SAFE_FORWARD_METHODS.has(req.method)) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'XRPC only supports GET and POST' })
    }

    let target: ProxyTarget | null
    try {
      target = await resolveProxyTarget(ctx, req, lxm)
    } catch (err) {
      logger.warn({ err, lxm }, 'proxy: failed to resolve target')
      return res.status(500).json({ error: 'UpstreamFailure', message: 'Could not resolve proxy target' })
    }

    if (!target) {
      return res.status(501).json({
        error: 'MethodNotImplemented',
        message: `No handler or proxy target configured for: ${lxm}`,
      })
    }

    // Build requester DID (from auth token if present, otherwise anonymous)
    let issuerDid: string | null = null
    const authHeader = req.headers['authorization']
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jose.decodeJwt(authHeader.slice(7))
        if (typeof payload.sub === 'string') issuerDid = payload.sub
      } catch { /* ignore */ }
    }

    // Build forward request headers
    const forwardHeaders: Record<string, string> = {}

    // Forward safe incoming headers
    const passHeaders = [
      'accept', 'accept-encoding', 'accept-language',
      'content-type', 'content-encoding', 'content-length',
      'atproto-accept-labelers', 'x-bsky-topics',
    ]
    for (const h of passHeaders) {
      const v = req.headers[h]
      if (v) forwardHeaders[h] = Array.isArray(v) ? v.join(', ') : v
    }

    // Service-auth JWT
    if (issuerDid) {
      try {
        const jwt = await makeServiceAuthJwt(ctx, issuerDid, target.did, lxm)
        forwardHeaders['authorization'] = `Bearer ${jwt}`
      } catch (err) {
        logger.warn({ err, lxm }, 'proxy: failed to build service auth jwt')
        // proceed without auth — upstream may reject, but don't crash
      }
    }

    // Build upstream URL
    const upstreamUrl = `${target.url}/xrpc/${lxm}${req._parsedUrl?.search ?? req.url.includes('?') ? (req.url.split('?')[1] ? `?${req.url.split('?')[1]}` : '') : ''}`

    // For POST requests capture body
    let body: string | Buffer | undefined
    if (req.method === 'POST') {
      if (Buffer.isBuffer(req.body)) {
        body = req.body
      } else if (req.body && typeof req.body === 'object') {
        body = JSON.stringify(req.body)
        forwardHeaders['content-type'] = 'application/json'
        forwardHeaders['content-length'] = String(Buffer.byteLength(body))
      }
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: body ?? (req.method === 'POST' ? null : undefined),
        signal: AbortSignal.timeout(30_000),
        // @ts-ignore — Node 18+ supports duplex
        duplex: req.method === 'POST' ? 'half' : undefined,
      })

      // Forward response status + headers
      res.status(upstream.status)

      const FWD_RES_HEADERS = [
        'content-type', 'content-encoding', 'content-language',
        'atproto-repo-rev', 'atproto-content-labelers', 'retry-after',
      ]
      for (const h of FWD_RES_HEADERS) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }

      // Stream body
      if (upstream.body) {
        const reader = upstream.body.getReader()
        const write = () =>
          reader.read().then(({ done, value }) => {
            if (done) { res.end(); return }
            res.write(value)
            write()
          }).catch((err) => {
            logger.warn({ err, lxm }, 'proxy: upstream body read error')
            if (!res.headersSent) res.status(502).end()
            else res.end()
          })
        write()
      } else {
        res.end()
      }
    } catch (err) {
      logger.error({ err, lxm, upstreamUrl }, 'proxy: upstream request failed')
      if (!res.headersSent) {
        res.status(502).json({ error: 'UpstreamFailure', message: 'Upstream service unreachable' })
      }
    }
  }
}

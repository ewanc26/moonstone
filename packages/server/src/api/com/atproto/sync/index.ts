import { Router, Request, Response } from 'express'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { CID } from 'multiformats/cid'
import { byteIterableToStream } from '@atproto/common'
import { blocksToCarStream, BlobNotFoundError, getRecords } from '@atproto/repo'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { cborEncode } from '@atproto/common'
import type { AppContext } from '../../../../context.js'
import { RepoRootNotFoundError } from '../../../../actor-store/index.js'
import { formatAccountStatus, INVALID_HANDLE } from '../../../../account-manager/index.js'
import { Outbox } from '../../../../sequencer/outbox.js'
import { logger } from '../../../../logger.js'

function xErr(res: Response, err: unknown) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
  }
  return res.status(500).json({ error: 'InternalServerError', message: String(err) })
}

function requireDid(query: Record<string, any>): string {
  const did = query.did as string
  if (!did) throw new InvalidRequestError('did is required')
  return did
}

// ── WebSocket server for subscribeRepos ────────────────────────────────────

export function attachSubscribeRepos(server: http.Server, ctx: AppContext) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/xrpc/com.atproto.sync.subscribeRepos') return
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      wss.emit('connection', ws, req, url)
    })
  })

  wss.on('connection', async (ws: WebSocket, _req: http.IncomingMessage, url: URL) => {
    const cursorStr = url.searchParams.get('cursor')
    const cursor = cursorStr !== null ? parseInt(cursorStr, 10) : undefined
    const ac = new AbortController()

    ws.on('close', () => ac.abort())
    ws.on('error', () => ac.abort())

    try {
      const outbox = new Outbox(ctx.sequencer, { maxBufferSize: 500 })
      const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
      const backfillTime = new Date(Date.now() - BACKFILL_MS).toISOString()

      let outboxCursor: number | undefined
      if (cursor !== undefined) {
        const curr = ctx.sequencer.curr() ?? 0
        if (cursor > curr) {
          sendWsMsg(ws, { $type: '#error', name: 'FutureCursor', message: 'Cursor in the future.' })
          ws.close()
          return
        }
        const next = ctx.sequencer.next(cursor)
        if (next && next.sequencedAt < backfillTime) {
          sendWsMsg(ws, { $type: '#info', name: 'OutdatedCursor', message: 'Requested cursor exceeded limit.' })
          const earliest = ctx.sequencer.earliestAfterTime(backfillTime)
          outboxCursor = earliest?.seq ? earliest.seq - 1 : undefined
        } else {
          outboxCursor = cursor
        }
      }

      for await (const evt of outbox.events(outboxCursor, ac.signal)) {
        if (ws.readyState !== WebSocket.OPEN) break
        let msg: Record<string, unknown>
        if (evt.type === 'commit') {
          msg = { $type: '#commit', seq: evt.seq, time: evt.time, ...evt.evt }
        } else if (evt.type === 'sync') {
          msg = { $type: '#sync', seq: evt.seq, time: evt.time, ...evt.evt }
        } else if (evt.type === 'identity') {
          msg = { $type: '#identity', seq: evt.seq, time: evt.time, ...evt.evt }
        } else {
          msg = { $type: '#account', seq: evt.seq, time: evt.time, ...evt.evt }
        }
        sendWsMsg(ws, msg)
      }
    } catch (err) {
      logger.error({ err }, 'subscribeRepos error')
      try { ws.close() } catch { /* ignore */ }
    }
  })

  return wss
}

function sendWsMsg(ws: WebSocket, obj: Record<string, unknown>) {
  try {
    ws.send(cborEncode(obj))
  } catch { /* ignore */ }
}

// ── HTTP sync routes ────────────────────────────────────────────────────────

export function mountSyncRoutes(router: Router, ctx: AppContext) {

  // ── requestCrawl ────────────────────────────────────────────────────────
  // External relay asks us to register for crawling.
  router.post('/xrpc/com.atproto.sync.requestCrawl', async (req, res) => {
    // We accept but do nothing — our crawlers push to relays, not the other way.
    res.status(200).end()
  })

  // ── notifyOfUpdate ────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.sync.notifyOfUpdate', async (req, res) => {
    // Admin-initiated crawl notification — fan out to all configured crawlers.
    await ctx.crawlers.notifyOfUpdate().catch(() => {})
    res.status(200).end()
  })


  // ── getRepoStatus ──────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getRepoStatus', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
      if (!account) throw new InvalidRequestError(`Could not find account: ${did}`)
      const { active, status } = formatAccountStatus(account)
      let rev: string | undefined
      if (active) {
        const root = ctx.accountManager.getRepoRoot(did)
        rev = root?.rev
      }
      res.json({ did, active, status, rev })
    } catch (err) { xErr(res, err) }
  })

  // ── getLatestCommit ────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getLatestCommit', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const reader = ctx.actorStore.reader(did)
      let root: { cid: CID; rev: string }
      try {
        root = await reader.storage.getRootDetailed()
      } catch (err) {
        if (err instanceof RepoRootNotFoundError) throw new InvalidRequestError(`Could not find root for DID: ${did}`, 'RepoNotFound')
        throw err
      }
      res.json({ cid: root.cid.toString(), rev: root.rev })
    } catch (err) { xErr(res, err) }
  })

  // ── getRepo ────────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getRepo', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const since = req.query.since as string | undefined
      const reader = ctx.actorStore.reader(did)
      let carIter: AsyncIterable<Uint8Array>
      try {
        carIter = await reader.storage.getCarStream(since)
      } catch (err) {
        if (err instanceof RepoRootNotFoundError) throw new InvalidRequestError(`Could not find repo for DID: ${did}`)
        throw err
      }
      res.setHeader('content-type', 'application/vnd.ipld.car')
      byteIterableToStream(carIter).pipe(res)
    } catch (err) { xErr(res, err) }
  })

  // ── getRecord (sync) ────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getRecord', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const collection = req.query.collection as string
      const rkey = req.query.rkey as string
      if (!collection || !rkey) throw new InvalidRequestError('collection and rkey are required')

      const reader = ctx.actorStore.reader(did)
      let root: CID
      try {
        root = await reader.storage.getRoot()
      } catch {
        throw new InvalidRequestError(`Could not find repo for DID: ${did}`)
      }
      const carIter = getRecords(reader.storage, root, [{ collection, rkey }])
      res.setHeader('content-type', 'application/vnd.ipld.car')
      byteIterableToStream(carIter).pipe(res)
    } catch (err) { xErr(res, err) }
  })

  // ── getBlocks ──────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getBlocks', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const cidStrs = [req.query.cids].flat().filter(Boolean) as string[]
      if (cidStrs.length === 0) throw new InvalidRequestError('cids is required')
      const cids = cidStrs.map((c) => CID.parse(c))

      const reader = ctx.actorStore.reader(did)
      const { blocks, missing } = await reader.storage.getBlocks(cids)
      if (missing.length > 0) {
        throw new InvalidRequestError(`Could not find cids: ${missing.map((c) => c.toString())}`)
      }
      const car = blocksToCarStream(null, blocks)
      res.setHeader('content-type', 'application/vnd.ipld.car')
      byteIterableToStream(car).pipe(res)
    } catch (err) { xErr(res, err) }
  })

  // ── getBlob ────────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.getBlob', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const cidStr = req.query.cid as string
      if (!cidStr) throw new InvalidRequestError('cid is required')
      const cid = CID.parse(cidStr)

      const reader = ctx.actorStore.reader(did)
      const found = await reader.blob.getBlob(did, cid)
      res.setHeader('content-length', String(found.size))
      res.setHeader('content-type', found.mimeType || 'application/octet-stream')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-security-policy', `default-src 'none'; sandbox`)
      found.stream.pipe(res)
    } catch (err) { xErr(res, err) }
  })

  // ── listBlobs ──────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.listBlobs', async (req, res) => {
    try {
      const did = requireDid(req.query)
      const since = req.query.since as string | undefined
      const cursor = req.query.cursor as string | undefined
      const limit = Math.min(parseInt((req.query.limit as string) ?? '500', 10), 1000)

      const reader = ctx.actorStore.reader(did)
      const cids = reader.blob.listBlobs({ did, since, cursor, limit })
      res.json({ cursor: cids.at(-1), cids })
    } catch (err) { xErr(res, err) }
  })

  // ── listRepos ──────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.sync.listRepos', async (req, res) => {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) ?? '500', 10), 1000)
      const cursor = req.query.cursor as string | undefined

      let sql = `
        SELECT a.did, rr.cid as head, rr.rev, a.createdAt, a.deactivatedAt, a.takedownRef
        FROM actor a
        JOIN repo_root rr ON rr.did = a.did
        WHERE 1=1
      `
      const args: unknown[] = []
      if (cursor) { sql += ` AND a.createdAt > ?`; args.push(cursor) }
      sql += ` ORDER BY a.createdAt ASC LIMIT ?`
      args.push(limit)

      const rows = ctx.db.prepare(sql).all(...args) as {
        did: string; head: string; rev: string; createdAt: string; deactivatedAt: string | null; takedownRef: string | null
      }[]

      const repos = rows.map((row) => {
        const { active, status } = formatAccountStatus(row)
        return { did: row.did, head: row.head, rev: row.rev ?? '', active, status }
      })

      res.json({ cursor: rows.at(-1)?.createdAt, repos })
    } catch (err) { xErr(res, err) }
  })
}

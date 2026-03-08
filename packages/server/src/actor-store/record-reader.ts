import { CID } from 'multiformats/cid'
import { cborToLexRecord } from '@atproto/repo'
import { BlobRef, RepoRecord } from '@atproto/lexicon'
import { AtUri } from '@atproto/syntax'
import type { Db } from '../db/index.js'

type RawRecord = {
  uri: string; did: string; cid: string; collection: string; rkey: string
  repoRev: string; indexedAt: string; takedownRef: string | null
  content: Uint8Array
}

type RawBacklink = { uri: string; path: string; linkTo: string }

export class RecordReader {
  constructor(protected db: Db) {}

  getRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted = false,
  ): { uri: string; cid: string; value: Record<string, unknown>; indexedAt: string; takedownRef: string | null } | null {
    let sql = `
      SELECT r.uri, r.did, r.cid, r.collection, r.rkey, r.repoRev, r.indexedAt, r.takedownRef, b.content
      FROM record r
      JOIN repo_block b ON b.did = r.did AND b.cid = r.cid
      WHERE r.uri = ?
    `
    const args: unknown[] = [uri.toString()]
    if (!includeSoftDeleted) { sql += ` AND r.takedownRef IS NULL`; }
    if (cid) { sql += ` AND r.cid = ?`; args.push(cid) }
    const row = this.db.prepare(sql).get(...args) as RawRecord | undefined
    if (!row) return null
    return {
      uri: row.uri,
      cid: row.cid,
      value: cborToLexRecord(row.content),
      indexedAt: row.indexedAt,
      takedownRef: row.takedownRef,
    }
  }

  hasRecord(uri: AtUri, cid: string | null, includeSoftDeleted = false): boolean {
    return this.getRecord(uri, cid, includeSoftDeleted) !== null
  }

  listCollections(did: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT collection FROM record WHERE did = ?`)
      .all(did) as { collection: string }[]
    return rows.map((r) => r.collection)
  }

  listRecordsForCollection(opts: {
    did: string
    collection: string
    limit: number
    reverse: boolean
    cursor?: string
  }): { uri: string; cid: string; value: Record<string, unknown> }[] {
    const { did, collection, limit, reverse, cursor } = opts
    const dir = reverse ? 'ASC' : 'DESC'
    let sql = `
      SELECT r.uri, r.cid, b.content
      FROM record r
      JOIN repo_block b ON b.did = r.did AND b.cid = r.cid
      WHERE r.did = ? AND r.collection = ? AND r.takedownRef IS NULL
    `
    const args: unknown[] = [did, collection]
    if (cursor) {
      sql += reverse ? ` AND r.rkey > ?` : ` AND r.rkey < ?`
      args.push(cursor)
    }
    sql += ` ORDER BY r.rkey ${dir} LIMIT ?`
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as { uri: string; cid: string; content: Uint8Array }[]
    return rows.map((r) => ({ uri: r.uri, cid: r.cid, value: cborToLexRecord(r.content) }))
  }

  getCurrentRecordCid(uri: AtUri): CID | null {
    const row = this.db
      .prepare(`SELECT cid FROM record WHERE uri = ?`)
      .get(uri.toString()) as { cid: string } | undefined
    return row ? CID.parse(row.cid) : null
  }

  getRecordBacklinks(opts: { collection: string; path: string; linkTo: string }): { rkey: string }[] {
    return this.db
      .prepare(`
        SELECT r.rkey FROM record r
        JOIN backlink bl ON bl.uri = r.uri
        WHERE bl.path = ? AND bl.linkTo = ? AND r.collection = ?
      `)
      .all(opts.path, opts.linkTo, opts.collection) as { rkey: string }[]
  }

  getBacklinkConflicts(uri: AtUri, record: RepoRecord): AtUri[] {
    const conflicts: AtUri[] = []
    for (const bl of getBacklinks(uri, record)) {
      const rows = this.getRecordBacklinks({ collection: uri.collection, path: bl.path, linkTo: bl.linkTo })
      for (const { rkey } of rows) {
        conflicts.push(AtUri.make(uri.hostname, uri.collection, rkey))
      }
    }
    return conflicts
  }

  recordCount(did: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM record WHERE did = ?`)
      .get(did) as { cnt: number }
    return row.cnt
  }

  listAll(did: string): { uri: string; cid: CID }[] {
    const rows = this.db
      .prepare(`SELECT uri, cid FROM record WHERE did = ? ORDER BY uri ASC`)
      .all(did) as { uri: string; cid: string }[]
    return rows.map((r) => ({ uri: r.uri, cid: CID.parse(r.cid) }))
  }
}

// ── Backlink extraction (follows, blocks, likes, reposts) ──────────────────

type BacklinkRow = { uri: string; path: string; linkTo: string }

export function getBacklinks(uri: AtUri, record: RepoRecord): BacklinkRow[] {
  const type = record?.['$type']
  if (
    type === 'app.bsky.graph.follow' ||
    type === 'app.bsky.graph.block'
  ) {
    const subject = record['subject']
    if (typeof subject !== 'string') return []
    return [{ uri: uri.toString(), path: 'subject', linkTo: subject }]
  }
  if (
    type === 'app.bsky.feed.like' ||
    type === 'app.bsky.feed.repost'
  ) {
    const subjectUri = (record['subject'] as any)?.uri
    if (typeof subjectUri !== 'string') return []
    return [{ uri: uri.toString(), path: 'subject.uri', linkTo: subjectUri }]
  }
  return []
}

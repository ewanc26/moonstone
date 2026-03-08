import stream from 'node:stream'
import { CID } from 'multiformats/cid'
import { BlobNotFoundError, BlobStore } from '@atproto/repo'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { Db } from '../db/index.js'

export class BlobReader {
  constructor(protected db: Db, protected blobstore: BlobStore) {}

  async getBlobMetadata(did: string, cid: CID): Promise<{ size: number; mimeType: string }> {
    const row = this.db
      .prepare(`SELECT size, mimeType FROM blob WHERE did = ? AND cid = ? AND takedownRef IS NULL`)
      .get(did, cid.toString()) as { size: number; mimeType: string } | undefined
    if (!row) throw new InvalidRequestError('Blob not found', 'BlobNotFound')
    return row
  }

  async getBlob(did: string, cid: CID): Promise<{ size: number; mimeType: string; stream: stream.Readable }> {
    const meta = await this.getBlobMetadata(did, cid)
    let blobStream: stream.Readable
    try {
      blobStream = await this.blobstore.getStream(cid)
    } catch (err) {
      if (err instanceof BlobNotFoundError) throw new InvalidRequestError('Blob not found', 'BlobNotFound')
      throw err
    }
    return { ...meta, stream: blobStream }
  }

  listBlobs(opts: { did: string; since?: string; cursor?: string; limit: number }): string[] {
    const { did, since, cursor, limit } = opts
    let sql = `
      SELECT DISTINCT rb.blobCid FROM record_blob rb
      ${since ? `JOIN record r ON r.uri = rb.recordUri AND r.repoRev > ?` : ''}
      WHERE rb.did = ?
      ${cursor ? `AND rb.blobCid > ?` : ''}
      ORDER BY rb.blobCid ASC
      LIMIT ?
    `
    const args: unknown[] = []
    if (since) args.push(since)
    args.push(did)
    if (cursor) args.push(cursor)
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as { blobCid: string }[]
    return rows.map((r) => r.blobCid)
  }

  listMissingBlobs(opts: { did: string; cursor?: string; limit: number }): { cid: string; recordUri: string }[] {
    const { did, cursor, limit } = opts
    let sql = `
      SELECT rb.blobCid, rb.recordUri FROM record_blob rb
      WHERE rb.did = ?
        AND NOT EXISTS (SELECT 1 FROM blob b WHERE b.did = rb.did AND b.cid = rb.blobCid)
      ${cursor ? `AND rb.blobCid > ?` : ''}
      GROUP BY rb.blobCid
      ORDER BY rb.blobCid ASC
      LIMIT ?
    `
    const args: unknown[] = [did]
    if (cursor) args.push(cursor)
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as { blobCid: string; recordUri: string }[]
    return rows.map((r) => ({ cid: r.blobCid, recordUri: r.recordUri }))
  }

  getRecordsForBlob(did: string, cid: CID): string[] {
    const rows = this.db
      .prepare(`SELECT recordUri FROM record_blob WHERE did = ? AND blobCid = ?`)
      .all(did, cid.toString()) as { recordUri: string }[]
    return rows.map((r) => r.recordUri)
  }
}

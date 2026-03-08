import { CID } from 'multiformats/cid'
import { chunkArray } from '@atproto/common'
import { BlockMap, CarBlock, CidSet, ReadableBlockstore, writeCarStream } from '@atproto/repo'
import type { Db } from '../db/index.js'

export class RepoRootNotFoundError extends Error {}

type RevCursor = { cid: CID; rev: string }

export class SqlRepoReader extends ReadableBlockstore {
  cache: BlockMap = new BlockMap()

  constructor(public db: Db, public did: string) {
    super()
  }

  async getRoot(): Promise<CID> {
    const r = await this.getRootDetailed()
    return r.cid
  }

  async getRootDetailed(): Promise<{ cid: CID; rev: string }> {
    const row = this.db
      .prepare(`SELECT cid, rev FROM repo_root WHERE did = ?`)
      .get(this.did) as { cid: string; rev: string } | undefined
    if (!row) throw new RepoRootNotFoundError(`No repo root for ${this.did}`)
    return { cid: CID.parse(row.cid), rev: row.rev }
  }

  async getBytes(cid: CID): Promise<Uint8Array | null> {
    const cached = this.cache.get(cid)
    if (cached) return cached
    const row = this.db
      .prepare(`SELECT content FROM repo_block WHERE did = ? AND cid = ?`)
      .get(this.did, cid.toString()) as { content: Uint8Array } | undefined
    if (!row) return null
    this.cache.set(cid, row.content)
    return row.content
  }

  async has(cid: CID): Promise<boolean> {
    return (await this.getBytes(cid)) !== null
  }

  async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
    const cached = this.cache.getMany(cids)
    if (cached.missing.length === 0) return cached
    const missing = new CidSet(cached.missing)
    const blocks = new BlockMap()

    for (const batch of chunkArray(cached.missing.map((c) => c.toString()), 500)) {
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db
        .prepare(`SELECT cid, content FROM repo_block WHERE did = ? AND cid IN (${placeholders})`)
        .all(this.did, ...batch) as { cid: string; content: Uint8Array }[]
      for (const row of rows) {
        const cid = CID.parse(row.cid)
        blocks.set(cid, row.content)
        missing.delete(cid)
      }
    }

    this.cache.addMap(blocks)
    blocks.addMap(cached.blocks)
    return { blocks, missing: missing.toList() }
  }

  async getCarStream(since?: string): Promise<AsyncIterable<Uint8Array>> {
    const root = await this.getRoot()
    return writeCarStream(root, this._iterateCarBlocks(since))
  }

  async *_iterateCarBlocks(since?: string): AsyncIterable<CarBlock> {
    let cursor: RevCursor | undefined
    do {
      const rows = this._getBlockRange(since, cursor)
      for (const row of rows) {
        yield { cid: CID.parse(row.cid), bytes: row.content }
      }
      const last = rows.at(-1)
      cursor = last ? { cid: CID.parse(last.cid), rev: last.repoRev } : undefined
    } while (cursor)
  }

  private _getBlockRange(since?: string, cursor?: RevCursor) {
    let sql = `SELECT cid, repoRev, content FROM repo_block WHERE did = ?`
    const args: unknown[] = [this.did]
    if (cursor) {
      sql += ` AND (repoRev < ? OR (repoRev = ? AND cid < ?))`
      args.push(cursor.rev, cursor.rev, cursor.cid.toString())
    }
    if (since) {
      sql += ` AND repoRev > ?`
      args.push(since)
    }
    sql += ` ORDER BY repoRev DESC, cid DESC LIMIT 500`
    return this.db.prepare(sql).all(...args) as { cid: string; repoRev: string; content: Uint8Array }[]
  }

  async countBlocks(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM repo_block WHERE did = ?`)
      .get(this.did) as { cnt: number }
    return row.cnt
  }

  async destroy(): Promise<void> {
    throw new Error('Destruction of SQL repo storage not allowed')
  }
}

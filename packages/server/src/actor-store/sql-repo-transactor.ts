import { CID } from 'multiformats/cid'
import { chunkArray } from '@atproto/common'
import { BlockMap, CommitData, RepoStorage } from '@atproto/repo'
import type { Db } from '../db/index.js'
import { SqlRepoReader } from './sql-repo-reader.js'

export class SqlRepoTransactor extends SqlRepoReader implements RepoStorage {
  now: string

  constructor(db: Db, did: string, now?: string) {
    super(db, did)
    this.now = now ?? new Date().toISOString()
  }

  /** Pre-warm cache with blocks from a given rev to avoid repeated round-trips. */
  cacheRev(rev: string): void {
    const rows = this.db
      .prepare(`SELECT cid, content FROM repo_block WHERE did = ? AND repoRev = ? LIMIT 15`)
      .all(this.did, rev) as { cid: string; content: Uint8Array }[]
    for (const row of rows) {
      this.cache.set(CID.parse(row.cid), row.content)
    }
  }

  async putBlock(cid: CID, block: Uint8Array, rev: string): Promise<void> {
    this.db
      .prepare(`INSERT OR IGNORE INTO repo_block (did, cid, repoRev, size, content) VALUES (?, ?, ?, ?, ?)`)
      .run(this.did, cid.toString(), rev, block.length, block)
    this.cache.set(cid, block)
  }

  async putMany(toPut: BlockMap, rev: string): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO repo_block (did, cid, repoRev, size, content) VALUES (?, ?, ?, ?, ?)`,
    )
    const insert = this.db.transaction(() => {
      for (const [cid, bytes] of toPut) {
        stmt.run(this.did, cid.toString(), rev, bytes.length, bytes)
      }
    })
    insert()
    for (const [cid, bytes] of toPut) {
      this.cache.set(cid, bytes)
    }
  }

  async deleteMany(cids: CID[]): Promise<void> {
    if (cids.length === 0) return
    for (const batch of chunkArray(cids.map((c) => c.toString()), 500)) {
      const placeholders = batch.map(() => '?').join(',')
      this.db
        .prepare(`DELETE FROM repo_block WHERE did = ? AND cid IN (${placeholders})`)
        .run(this.did, ...batch)
    }
  }

  async applyCommit(commit: CommitData, isCreate = false): Promise<void> {
    this._updateRoot(commit.cid, commit.rev, isCreate)
    await this.putMany(commit.newBlocks, commit.rev)
    await this.deleteMany(commit.removedCids.toList())
  }

  private _updateRoot(cid: CID, rev: string, isCreate: boolean): void {
    if (isCreate) {
      this.db
        .prepare(`INSERT INTO repo_root (did, cid, rev, indexedAt) VALUES (?, ?, ?, ?)`)
        .run(this.did, cid.toString(), rev, this.now)
    } else {
      this.db
        .prepare(`UPDATE repo_root SET cid = ?, rev = ?, indexedAt = ? WHERE did = ?`)
        .run(cid.toString(), rev, this.now, this.did)
    }
  }

  async destroy(): Promise<void> {
    throw new Error('Destruction of SQL repo storage not allowed')
  }
}

import { CID } from 'multiformats/cid'
import { RepoRecord } from '@atproto/lexicon'
import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { Db } from '../db/index.js'
import { RecordReader, getBacklinks } from './record-reader.js'

export class RecordTransactor extends RecordReader {
  constructor(db: Db) {
    super(db)
  }

  indexRecord(
    uri: AtUri,
    cid: CID,
    record: RepoRecord | null,
    action: WriteOpAction.Create | WriteOpAction.Update,
    repoRev: string,
    now: string,
  ): void {
    const did = uri.hostname
    if (!did.startsWith('did:')) throw new Error('URI must contain a DID')
    const row = {
      uri: uri.toString(),
      did,
      cid: cid.toString(),
      collection: uri.collection,
      rkey: uri.rkey,
      repoRev,
      indexedAt: now,
    }
    this.db.prepare(`
      INSERT INTO record (uri, did, cid, collection, rkey, repoRev, indexedAt)
      VALUES (@uri, @did, @cid, @collection, @rkey, @repoRev, @indexedAt)
      ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, repoRev = excluded.repoRev, indexedAt = excluded.indexedAt
    `).run(row)

    if (record !== null) {
      if (action === WriteOpAction.Update) this._removeBacklinksByUri(uri)
      this._addBacklinks(getBacklinks(uri, record))
    }
  }

  deleteRecord(uri: AtUri): void {
    this.db.prepare(`DELETE FROM record WHERE uri = ?`).run(uri.toString())
    this.db.prepare(`DELETE FROM backlink WHERE uri = ?`).run(uri.toString())
  }

  private _removeBacklinksByUri(uri: AtUri): void {
    this.db.prepare(`DELETE FROM backlink WHERE uri = ?`).run(uri.toString())
  }

  private _addBacklinks(backlinks: { uri: string; path: string; linkTo: string }[]): void {
    if (backlinks.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO backlink (uri, path, linkTo) VALUES (?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      for (const bl of backlinks) stmt.run(bl.uri, bl.path, bl.linkTo)
    })
    tx()
  }
}

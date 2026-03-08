import { CID } from 'multiformats/cid'
import { formatDataKey, Repo, WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import { InvalidRequestError } from '@atproto/xrpc-server'
import * as AtprotoCrypto from '@atproto/crypto'
import type { Db } from '../db/index.js'
import type { BlobStore } from '@atproto/repo'
import { SqlRepoTransactor } from './sql-repo-transactor.js'
import { RecordTransactor } from './record-transactor.js'
import { BlobTransactor } from './blob-transactor.js'
import {
  BadCommitSwapError, BadRecordSwapError,
  CommitDataWithOps, CommitOp,
  PreparedCreate, PreparedWrite,
  InvalidRecordError,
} from '../repo/index.js'
import { writeToOp, createWriteToOp } from '../repo/prepare.js'

export class RepoTransactor {
  storage: SqlRepoTransactor
  record: RecordTransactor
  blob: BlobTransactor
  now: string

  constructor(
    public db: Db,
    public did: string,
    public signingKey: AtprotoCrypto.Keypair,
    public blobstore: BlobStore,
    now?: string,
  ) {
    this.now = now ?? new Date().toISOString()
    this.storage = new SqlRepoTransactor(db, did, this.now)
    this.record = new RecordTransactor(db)
    this.blob = new BlobTransactor(db, blobstore)
  }

  async maybeLoadRepo(): Promise<Repo | null> {
    const row = this.db
      .prepare(`SELECT cid FROM repo_root WHERE did = ?`)
      .get(this.did) as { cid: string } | undefined
    if (!row) return null
    return Repo.load(this.storage, CID.parse(row.cid))
  }

  async createRepo(writes: PreparedCreate[]): Promise<CommitDataWithOps> {
    const commit = await Repo.formatInitCommit(
      this.storage,
      this.did,
      this.signingKey,
      writes.map(createWriteToOp),
    )
    await this.storage.applyCommit(commit, true)
    this._indexWrites(writes, commit.rev)
    await this.blob.processWriteBlobs(this.did, commit.rev, writes)
    const ops: CommitOp[] = writes.map((w) => ({
      action: 'create' as const,
      path: formatDataKey(w.uri.collection, w.uri.rkey),
      cid: w.cid,
    }))
    return { ...commit, ops, prevData: null }
  }

  async processWrites(
    writes: PreparedWrite[],
    swapCommitCid?: CID,
  ): Promise<CommitDataWithOps> {
    if (writes.length > 200) throw new InvalidRequestError('Too many writes. Max: 200')
    const commit = await this._formatCommit(writes, swapCommitCid)
    if (commit.relevantBlocks.byteSize > 2_000_000) {
      throw new InvalidRequestError('Too many writes. Max event size: 2MB')
    }
    await this.storage.applyCommit(commit)
    this._indexWrites(writes, commit.rev)
    await this.blob.processWriteBlobs(this.did, commit.rev, writes)
    return commit
  }

  private async _formatCommit(
    writes: PreparedWrite[],
    swapCommit?: CID,
  ): Promise<CommitDataWithOps> {
    const currRoot = await this.storage.getRootDetailed()
    if (swapCommit && !currRoot.cid.equals(swapCommit)) {
      throw new BadCommitSwapError(currRoot.cid)
    }
    this.storage.cacheRev(currRoot.rev)

    const newRecordCids: CID[] = []
    const delAndUpdateUris: AtUri[] = []
    const commitOps: CommitOp[] = []

    for (const write of writes) {
      const { action, uri } = write
      if (action !== WriteOpAction.Delete) newRecordCids.push((write as any).cid)
      if (action !== WriteOpAction.Create) delAndUpdateUris.push(uri)

      const current = this.record.getCurrentRecordCid(uri)
      const op: CommitOp = {
        action: action as any,
        path: formatDataKey(uri.collection, uri.rkey),
        cid: action === WriteOpAction.Delete ? null : (write as any).cid,
      }
      if (current) op.prev = current

      const swapCid = (write as any).swapCid
      if (swapCid !== undefined) {
        if (action === WriteOpAction.Create && swapCid !== null) throw new BadRecordSwapError(current)
        if (action === WriteOpAction.Update && swapCid === null) throw new BadRecordSwapError(current)
        if (action === WriteOpAction.Delete && swapCid === null) throw new BadRecordSwapError(current)
        if ((current || swapCid) && !current?.equals(swapCid)) throw new BadRecordSwapError(current)
      }
      commitOps.push(op)
    }

    const repo = await Repo.load(this.storage, currRoot.cid)
    const prevData = repo.commit.data
    const commit = await repo.formatCommit(writes.map(writeToOp), this.signingKey)

    // Don't remove blocks still referenced by other records
    const dupCids = this._getDuplicateRecordCids(commit.removedCids.toList(), delAndUpdateUris)
    for (const cid of dupCids) commit.removedCids.delete(cid)

    // Ensure new record blocks are in relevantBlocks
    const { missing } = commit.relevantBlocks.getMany(newRecordCids)
    if (missing.length > 0) {
      const { blocks } = await this.storage.getBlocks(missing)
      commit.relevantBlocks.addMap(blocks)
    }

    return { ...commit, ops: commitOps, prevData }
  }

  private _indexWrites(writes: PreparedWrite[], rev: string): void {
    for (const write of writes) {
      if (write.action === WriteOpAction.Create || write.action === WriteOpAction.Update) {
        this.record.indexRecord(write.uri, write.cid, write.record, write.action, rev, this.now)
      } else if (write.action === WriteOpAction.Delete) {
        this.record.deleteRecord(write.uri)
      }
    }
  }

  private _getDuplicateRecordCids(cids: CID[], touchedUris: AtUri[]): CID[] {
    if (touchedUris.length === 0 || cids.length === 0) return []
    const cidStrs = cids.map((c) => c.toString())
    const uriStrs = touchedUris.map((u) => u.toString())
    const cidPlaceholders = cidStrs.map(() => '?').join(',')
    const uriPlaceholders = uriStrs.map(() => '?').join(',')
    const rows = this.db
      .prepare(`
        SELECT cid FROM record
        WHERE cid IN (${cidPlaceholders}) AND uri NOT IN (${uriPlaceholders})
      `)
      .all(...cidStrs, ...uriStrs) as { cid: string }[]
    return rows.map((r) => CID.parse(r.cid))
  }
}

/**
 * ActorStore — the unified interface for per-account repo + record + blob operations.
 *
 * Unlike the blacksky reference (which uses per-actor SQLite files), moonstone
 * uses a single shared DB with DID-scoped tables. The ActorStore wraps a
 * RepoTransactor (which holds a SQLite transaction) for write operations, and
 * exposes simple read helpers for query-only paths.
 */
import type { BlobStore } from '@atproto/repo'
import * as AtprotoCrypto from '@atproto/crypto'
import type { Db } from '../db/index.js'
import { SqlRepoReader, RepoRootNotFoundError } from './sql-repo-reader.js'
import { RecordReader } from './record-reader.js'
import { BlobReader } from './blob-reader.js'
import { BlobTransactor } from './blob-transactor.js'
import { RepoTransactor } from './repo-transactor.js'

export { RepoRootNotFoundError }

// ---------------------------------------------------------------------------
// Read-only bundle (no DB transaction)
// ---------------------------------------------------------------------------

export class ActorReader {
  storage: SqlRepoReader
  record: RecordReader
  blob: BlobReader

  constructor(db: Db, did: string, blobstore: BlobStore) {
    this.storage = new SqlRepoReader(db, did)
    this.record = new RecordReader(db)
    this.blob = new BlobReader(db, blobstore)
  }
}

// ---------------------------------------------------------------------------
// ActorStore (stateless factory; all state held in DB)
// ---------------------------------------------------------------------------

export class ActorStore {
  constructor(
    private db: Db,
    private blobstore: BlobStore,
  ) {}

  /** Open a read-only view for the given DID. */
  reader(did: string): ActorReader {
    return new ActorReader(this.db, did, this.blobstore)
  }

  /**
   * Execute a transactional write against the actor's repo.
   * The callback receives a RepoTransactor; all DB writes are wrapped in a
   * SQLite transaction that is committed on success or rolled back on error.
   */
  async transact<T>(
    did: string,
    signingKey: AtprotoCrypto.Keypair,
    fn: (txn: RepoTransactor) => Promise<T>,
  ): Promise<T> {
    const now = new Date().toISOString()
    const txn = new RepoTransactor(this.db, did, signingKey, this.blobstore, now)
    let result: T
    const runTransaction = this.db.transaction(async () => {
      result = await fn(txn)
    })
    // better-sqlite3 transactions are synchronous but we need to support async callbacks.
    // We run the async fn outside the transaction wrapper and collect the result.
    // For true atomicity we use a manual BEGIN/COMMIT/ROLLBACK.
    return await this._runAsync(did, signingKey, fn)
  }

  private async _runAsync<T>(
    did: string,
    signingKey: AtprotoCrypto.Keypair,
    fn: (txn: RepoTransactor) => Promise<T>,
  ): Promise<T> {
    const now = new Date().toISOString()
    const txn = new RepoTransactor(this.db, did, signingKey, this.blobstore, now)
    this.db.prepare('BEGIN').run()
    try {
      const result = await fn(txn)
      this.db.prepare('COMMIT').run()
      return result
    } catch (err) {
      try { this.db.prepare('ROLLBACK').run() } catch { /* ignore */ }
      throw err
    }
  }

  /** Blob-only write outside a repo transaction (for uploadBlob). */
  get blob(): BlobTransactor {
    return new BlobTransactor(this.db, this.blobstore)
  }
}

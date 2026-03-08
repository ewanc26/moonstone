import crypto from 'node:crypto'
import stream from 'node:stream'
import { CID } from 'multiformats/cid'
import { sha256RawToCid, streamSize, cloneStream, SECOND } from '@atproto/common'
import { BlobRef } from '@atproto/lexicon'
import { BlobNotFoundError, BlobStore, WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { Db } from '../db/index.js'
import { BlobReader } from './blob-reader.js'
import type { PreparedBlobRef, PreparedWrite } from '../repo/types.js'
import { logger } from '../logger.js'

export type BlobMetadata = { tempKey: string; size: number; cid: CID; mimeType: string }

export class BlobTransactor extends BlobReader {
  constructor(db: Db, blobstore: BlobStore) {
    super(db, blobstore)
  }

  async uploadBlobAndGetMetadata(
    userSuggestedMime: string,
    blobStream: stream.Readable,
  ): Promise<BlobMetadata> {
    const [tempKey, size, sha256, sniffedMime] = await Promise.all([
      this.blobstore.putTemp(cloneStream(blobStream)),
      streamSize(cloneStream(blobStream)),
      sha256Stream(cloneStream(blobStream)),
      mimeTypeFromStream(cloneStream(blobStream)),
    ])
    const cid = sha256RawToCid(sha256)
    return { tempKey, size, cid, mimeType: sniffedMime ?? userSuggestedMime }
  }

  trackUntetheredBlob(did: string, meta: BlobMetadata): BlobRef {
    const existing = this.db
      .prepare(`SELECT takedownRef FROM blob WHERE did = ? AND cid = ?`)
      .get(did, meta.cid.toString()) as { takedownRef: string | null } | undefined
    if (existing?.takedownRef) {
      throw new InvalidRequestError('Blob has been taken down, cannot re-upload')
    }
    this.db.prepare(`
      INSERT INTO blob (did, cid, mimeType, size, tempKey, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(did, cid) DO UPDATE SET tempKey = excluded.tempKey WHERE blob.tempKey IS NOT NULL
    `).run(did, meta.cid.toString(), meta.mimeType, meta.size, meta.tempKey, new Date().toISOString())
    return new BlobRef(meta.cid, meta.mimeType, meta.size)
  }

  insertBlobs(did: string, recordUri: string, blobs: Iterable<BlobRef>): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO record_blob (did, blobCid, recordUri) VALUES (?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      for (const blob of blobs) stmt.run(did, blob.ref.toString(), recordUri)
    })
    tx()
  }

  async processWriteBlobs(did: string, rev: string, writes: PreparedWrite[]): Promise<void> {
    this._deleteDereferencedBlobs(did, writes)
    for (const write of writes) {
      if (write.action === WriteOpAction.Create || write.action === WriteOpAction.Update) {
        for (const blob of write.blobs) {
          this._associateBlob(did, blob, write.uri)
          await this._verifyBlobAndMakePermanent(did, blob)
        }
      }
    }
  }

  private async _verifyBlobAndMakePermanent(did: string, blob: PreparedBlobRef): Promise<void> {
    const row = this.db
      .prepare(`SELECT tempKey, size, mimeType FROM blob WHERE did = ? AND cid = ? AND takedownRef IS NULL`)
      .get(did, blob.cid.toString()) as { tempKey: string | null; size: number; mimeType: string } | undefined
    if (!row) throw new InvalidRequestError(`Could not find blob: ${blob.cid}`, 'BlobNotFound')
    if (!row.tempKey) return // already permanent

    _verifyBlob(blob, row)

    await this.blobstore.makePermanent(row.tempKey, blob.cid).catch((err) => {
      logger.error({ err, cid: blob.cid.toString() }, 'could not make blob permanent')
      throw err
    })

    this.db.prepare(`UPDATE blob SET tempKey = NULL WHERE did = ? AND tempKey = ?`).run(did, row.tempKey)
  }

  private _associateBlob(did: string, blob: PreparedBlobRef, recordUri: AtUri): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO record_blob (did, blobCid, recordUri) VALUES (?, ?, ?)
    `).run(did, blob.cid.toString(), recordUri.toString())
  }

  private _deleteDereferencedBlobs(did: string, writes: PreparedWrite[]): void {
    const uris = writes
      .filter((w) => w.action === WriteOpAction.Delete || w.action === WriteOpAction.Update)
      .map((w) => w.uri.toString())
    if (uris.length === 0) return

    const placeholders = uris.map(() => '?').join(',')
    const deleted = this.db.prepare(`
      DELETE FROM record_blob WHERE did = ? AND recordUri IN (${placeholders})
      RETURNING blobCid
    `).all(did, ...uris) as { blobCid: string }[]
    if (deleted.length === 0) return

    const deletedCids = deleted.map((r) => r.blobCid)
    const newCids = writes
      .filter((w) => w.action !== WriteOpAction.Delete)
      .flatMap((w) => (w as any).blobs?.map((b: PreparedBlobRef) => b.cid.toString()) ?? [])

    // Find cids still referenced by other records
    const stillRefPlaceholders = deletedCids.map(() => '?').join(',')
    const stillRef = this.db.prepare(`
      SELECT DISTINCT blobCid FROM record_blob WHERE did = ? AND blobCid IN (${stillRefPlaceholders})
    `).all(did, ...deletedCids) as { blobCid: string }[]
    const keepSet = new Set([...newCids, ...stillRef.map((r) => r.blobCid)])

    const toDelete = deletedCids.filter((c) => !keepSet.has(c))
    if (toDelete.length === 0) return

    const delPlaceholders = toDelete.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM blob WHERE did = ? AND cid IN (${delPlaceholders})`).run(did, ...toDelete)

    // Best-effort async cleanup from blobstore
    setImmediate(async () => {
      try {
        await this.blobstore.deleteMany(toDelete.map((c) => CID.parse(c)))
      } catch (err) {
        logger.error({ err, cids: toDelete }, 'could not delete blobs from blobstore')
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Stream(readable: stream.Readable): Promise<Uint8Array> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of readable) hash.update(chunk)
  hash.end()
  return hash.digest()
}

async function mimeTypeFromStream(readable: stream.Readable): Promise<string | undefined> {
  try {
    const { fileTypeFromStream } = await import('file-type')
    const result = await fileTypeFromStream(readable)
    return result?.mime
  } catch {
    // consume and discard
    readable.resume()
    return undefined
  }
}

function _verifyBlob(blob: PreparedBlobRef, found: { size: number; mimeType: string }) {
  if (blob.constraints.maxSize && found.size > blob.constraints.maxSize) {
    throw new InvalidRequestError(
      `File too large (${found.size} bytes, max ${blob.constraints.maxSize})`,
      'BlobTooLarge',
    )
  }
  if (blob.mimeType !== found.mimeType) {
    throw new InvalidRequestError(
      `Mimetype mismatch: expected ${found.mimeType}, got ${blob.mimeType}`,
      'InvalidMimeType',
    )
  }
  if (blob.constraints.accept && !acceptedMime(blob.mimeType, blob.constraints.accept)) {
    throw new InvalidRequestError(
      `Wrong type of file: ${blob.mimeType} must match ${blob.constraints.accept}`,
      'InvalidMimeType',
    )
  }
}

function acceptedMime(mime: string, accepted: string[]): boolean {
  if (accepted.includes('*/*')) return true
  for (const a of accepted) {
    if (a.endsWith('/*') && mime.startsWith(a.slice(0, -1))) return true
  }
  return accepted.includes(mime)
}

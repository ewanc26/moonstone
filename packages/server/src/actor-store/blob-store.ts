/**
 * LocalBlobStore — a simple on-disk BlobStore implementation.
 *
 * Layout:
 *   {blobsDir}/tmp/{tempKey}   ← awaiting promotion
 *   {blobsDir}/blocks/{cid}    ← permanent
 *   {blobsDir}/quarantine/{cid} ← taken-down
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsP from 'node:fs/promises'
import path from 'node:path'
import stream from 'node:stream'
import { CID } from 'multiformats/cid'
import { BlobNotFoundError, BlobStore } from '@atproto/repo'

export class LocalBlobStore implements BlobStore {
  private tmpDir: string
  private blocksDir: string
  private quarantineDir: string

  constructor(baseDir: string) {
    this.tmpDir = path.join(baseDir, 'tmp')
    this.blocksDir = path.join(baseDir, 'blocks')
    this.quarantineDir = path.join(baseDir, 'quarantine')
    fs.mkdirSync(this.tmpDir, { recursive: true })
    fs.mkdirSync(this.blocksDir, { recursive: true })
    fs.mkdirSync(this.quarantineDir, { recursive: true })
  }

  async putTemp(readable: stream.Readable): Promise<string> {
    const tempKey = crypto.randomBytes(16).toString('hex')
    const dest = path.join(this.tmpDir, tempKey)
    await pipeline(readable, fs.createWriteStream(dest))
    return tempKey
  }

  async makePermanent(tempKey: string, cid: CID): Promise<void> {
    const src = path.join(this.tmpDir, tempKey)
    const dest = path.join(this.blocksDir, cid.toString())
    try {
      await fsP.rename(src, dest)
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Already moved or didn't exist — check if permanent copy exists
        if (!fs.existsSync(dest)) throw new BlobNotFoundError()
      } else {
        throw err
      }
    }
  }

  async getStream(cid: CID): Promise<stream.Readable> {
    const filePath = path.join(this.blocksDir, cid.toString())
    if (!fs.existsSync(filePath)) throw new BlobNotFoundError()
    return fs.createReadStream(filePath)
  }

  async hasStored(cid: CID): Promise<boolean> {
    return fs.existsSync(path.join(this.blocksDir, cid.toString()))
  }

  async deleteMany(cids: CID[]): Promise<void> {
    await Promise.all(
      cids.map(async (cid) => {
        try {
          await fsP.unlink(path.join(this.blocksDir, cid.toString()))
        } catch {
          // ignore missing
        }
      }),
    )
  }

  async quarantine(cid: CID): Promise<void> {
    const src = path.join(this.blocksDir, cid.toString())
    const dest = path.join(this.quarantineDir, cid.toString())
    try {
      await fsP.rename(src, dest)
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  async unquarantine(cid: CID): Promise<void> {
    const src = path.join(this.quarantineDir, cid.toString())
    const dest = path.join(this.blocksDir, cid.toString())
    try {
      await fsP.rename(src, dest)
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  async deleteAll(): Promise<void> {
    await fsP.rm(this.blocksDir, { recursive: true, force: true })
    await fsP.mkdir(this.blocksDir, { recursive: true })
  }
}

function pipeline(readable: stream.Readable, writable: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    readable.on('error', reject)
    writable.on('error', reject)
    writable.on('finish', resolve)
    readable.pipe(writable)
  })
}

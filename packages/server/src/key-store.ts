import { Secp256k1Keypair, type ExportableKeypair } from '@atproto/crypto'
import type { Db } from './db/index.js'

/**
 * Manages per-DID signing keypairs stored in SQLite (as JWK).
 * Replaces @atproto/pds's ActorStore.keypair() / reserveKeypair() interface.
 */
export class KeyStore {
  constructor(private db: Db) {}

  async getOrCreateKeypair(did: string): Promise<ExportableKeypair> {
    const existing = this.db.prepare(
      `SELECT privateKeyJwk FROM signing_key WHERE did = ?`
    ).get(did) as { privateKeyJwk: string } | undefined

    if (existing) {
      return Secp256k1Keypair.import(JSON.parse(existing.privateKeyJwk), { exportable: true })
    }

    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const jwk = await keypair.export()
    this.db.prepare(`
      INSERT OR IGNORE INTO signing_key (did, privateKeyJwk, createdAt) VALUES (?, ?, ?)
    `).run(did, JSON.stringify(jwk), new Date().toISOString())

    return keypair
  }

  async getKeypair(did: string): Promise<ExportableKeypair | null> {
    const row = this.db.prepare(
      `SELECT privateKeyJwk FROM signing_key WHERE did = ?`
    ).get(did) as { privateKeyJwk: string } | undefined
    if (!row) return null
    return Secp256k1Keypair.import(JSON.parse(row.privateKeyJwk), { exportable: true })
  }

  /** Reserve a signing key for a DID before account creation (migration flow). */
  async reserveKeypair(did: string | undefined): Promise<ExportableKeypair> {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const jwk = await keypair.export()
    const key = did ?? keypair.did()
    this.db.prepare(`
      INSERT OR IGNORE INTO reserved_keypair (did, privateKeyJwk, createdAt) VALUES (?, ?, ?)
    `).run(key, JSON.stringify(jwk), new Date().toISOString())
    return keypair
  }

  async getReservedKeypair(did: string): Promise<ExportableKeypair | null> {
    const row = this.db.prepare(
      `SELECT privateKeyJwk FROM reserved_keypair WHERE did = ?`
    ).get(did) as { privateKeyJwk: string } | undefined
    if (!row) return null
    return Secp256k1Keypair.import(JSON.parse(row.privateKeyJwk), { exportable: true })
  }

  clearReservedKeypair(did: string) {
    this.db.prepare(`DELETE FROM reserved_keypair WHERE did = ?`).run(did)
  }

  /**
   * After DID:PLC creation, bind a provisional key (generated with a temporary
   * placeholder key label) to the real DID so future lookups succeed.
   */
  async promoteOrAssignKeypair(keypair: ExportableKeypair, did: string): Promise<void> {
    const jwk = await keypair.export()
    this.db.prepare(`
      INSERT OR REPLACE INTO signing_key (did, privateKeyJwk, createdAt) VALUES (?, ?, ?)
    `).run(did, JSON.stringify(jwk), new Date().toISOString())
  }

  promoteReservedKeypair(did: string): boolean {
    const row = this.db.prepare(
      `SELECT privateKeyJwk FROM reserved_keypair WHERE did = ?`
    ).get(did) as { privateKeyJwk: string } | undefined
    if (!row) return false
    this.db.prepare(`
      INSERT OR REPLACE INTO signing_key (did, privateKeyJwk, createdAt) VALUES (?, ?, ?)
    `).run(did, row.privateKeyJwk, new Date().toISOString())
    this.db.prepare(`DELETE FROM reserved_keypair WHERE did = ?`).run(did)
    return true
  }
}

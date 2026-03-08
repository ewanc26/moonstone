import crypto from 'node:crypto'
import path from 'node:path'
import { IdResolver } from '@atproto/identity'
import { Secp256k1Keypair, type ExportableKeypair } from '@atproto/crypto'
import type { MoonstoneConfig } from '@ewanc26/moonstone-config'
import type { Db } from './db/index.js'
import { AccountManager } from './account-manager/index.js'
import { AuthVerifier, makeJwtKey } from './auth/index.js'
import { KeyStore } from './key-store.js'
import { Mailer } from './mailer.js'
import { ActorStore } from './actor-store/index.js'
import { LocalBlobStore } from './actor-store/blob-store.js'
import { Sequencer } from './sequencer/index.js'
import { Crawlers } from './crawlers.js'

export type ExtendedConfig = MoonstoneConfig & {
  jwtSecret: string
  adminPassword: string
  blobsDir: string
  plcRotationKeyHex: string
}

export type AppContext = {
  cfg: ExtendedConfig
  db: Db
  accountManager: AccountManager
  authVerifier: AuthVerifier
  keyStore: KeyStore
  idResolver: IdResolver
  mailer: Mailer | null
  actorStore: ActorStore
  blobstore: LocalBlobStore
  sequencer: Sequencer
  crawlers: Crawlers
  plcRotationKey: ExportableKeypair
}

export async function buildAppContext(
  cfg: ExtendedConfig,
  db: Db,
): Promise<AppContext> {
  const accountManager = new AccountManager(
    db,
    cfg.jwtSecret,
    cfg.service.did,
    cfg.identity.serviceHandleDomains,
  )

  const jwtKey = makeJwtKey(cfg.jwtSecret)

  const authVerifier = new AuthVerifier(
    jwtKey,
    cfg.service.did,
    cfg.adminPassword,
    accountManager,
  )

  const keyStore = new KeyStore(db)

  const idResolver = new IdResolver({ plcUrl: cfg.identity.plcUrl })

  const mailer = cfg.email
    ? new Mailer(cfg.email.smtpUrl, cfg.email.fromAddress, cfg.service.hostname)
    : null

  const blobstore = new LocalBlobStore(cfg.blobsDir)
  const actorStore = new ActorStore(db, blobstore)
  const sequencer = new Sequencer(db)

  const crawlers = new Crawlers(cfg.service.hostname, cfg.crawlers)

  // Load PLC rotation key from 32-byte hex-encoded secp256k1 private key.
  // @atproto/crypto exposes Secp256k1Keypair.import() for JWK, so we convert
  // the hex bytes to a minimal JWK first.
  const privBytes = Buffer.from(cfg.plcRotationKeyHex, 'hex')
  const plcRotationKey = await Secp256k1Keypair.import(
    {
      kty: 'EC',
      crv: 'secp256k1',
      d: privBytes.toString('base64url'),
      // x/y are derived by the import — ok to omit per @atproto/crypto internals
    } as any,
    { exportable: true },
  )

  return {
    cfg,
    db,
    accountManager,
    authVerifier,
    keyStore,
    idResolver,
    mailer,
    actorStore,
    blobstore,
    sequencer,
    crawlers,
    plcRotationKey,
  }
}

import crypto from 'node:crypto'
import { IdResolver } from '@atproto/identity'
import type { MoonstoneConfig } from '@ewanc26/moonstone-config'
import type { Db } from './db/index.js'
import { AccountManager } from './account-manager/index.js'
import { AuthVerifier, makeJwtKey } from './auth/index.js'
import { KeyStore } from './key-store.js'
import { Mailer } from './mailer.js'

export type AppContext = {
  cfg: MoonstoneConfig & {
    jwtSecret: string
    adminPassword: string
  }
  db: Db
  accountManager: AccountManager
  authVerifier: AuthVerifier
  keyStore: KeyStore
  idResolver: IdResolver
  mailer: Mailer | null
  plcRotationKey: crypto.KeyObject
}

export function buildAppContext(
  cfg: MoonstoneConfig & { jwtSecret: string; adminPassword: string },
  db: Db,
): AppContext {
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

  const idResolver = new IdResolver({
    plcUrl: cfg.identity.plcUrl,
  })

  const mailer = cfg.email
    ? new Mailer(cfg.email.smtpUrl, cfg.email.fromAddress, cfg.service.hostname)
    : null

  // PLC rotation key is derived from the JWT secret for simplicity.
  // In production this should be a dedicated env var.
  const plcRotationKey = jwtKey

  return { cfg, db, accountManager, authVerifier, keyStore, idResolver, mailer, plcRotationKey }
}

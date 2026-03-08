import crypto from 'node:crypto'
import { randomStr } from '@atproto/crypto'
import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import { MINUTE, HOUR, DAY, lessThanAgoMs, wait } from '@atproto/common'
import { isValidTld, normalizeAndEnsureValidHandle, InvalidHandleError } from '@atproto/syntax'
import type { Db } from '../db/index.js'
import {
  makeJwtKey,
  createTokens,
  formatScope,
  getRefreshTokenId,
  decodeRefreshToken,
  verifyPassword,
  genSaltAndHash,
  hashAppPassword,
  hashWithSalt,
  NEW_PASSWORD_MAX_LENGTH,
  OLD_PASSWORD_MAX_LENGTH,
  AuthScope,
} from '../auth/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorAccount = {
  did: string
  handle: string | null
  createdAt: string
  takedownRef: string | null
  deactivatedAt: string | null
  deleteAfter: string | null
  email: string | null
  emailConfirmedAt: string | null
  invitesDisabled: number | null
}

export type AppPassDescript = { name: string; privileged: boolean }

export type EmailTokenPurpose =
  | 'confirm_email'
  | 'update_email'
  | 'reset_password'
  | 'delete_account'

export const INVALID_HANDLE = 'handle.invalid'

export enum AccountStatus {
  Active      = 'active',
  Takendown   = 'takendown',
  Suspended   = 'suspended',
  Deleted     = 'deleted',
  Deactivated = 'deactivated',
}

export class UserAlreadyExistsError extends Error {}

export const formatAccountStatus = (
  account: null | { takedownRef: string | null; deactivatedAt: string | null },
): { active: boolean; status: AccountStatus | undefined } => {
  if (!account)         return { active: false, status: AccountStatus.Deleted }
  if (account.takedownRef)   return { active: false, status: AccountStatus.Takendown }
  if (account.deactivatedAt) return { active: false, status: AccountStatus.Deactivated }
  return { active: true, status: undefined }
}

// ---------------------------------------------------------------------------
// AccountManager
// ---------------------------------------------------------------------------

export class AccountManager {
  constructor(
    private db: Db,
    private jwtSecret: string,
    private serviceDid: string,
    private serviceHandleDomains: string[],
  ) {}

  private get jwtKey() { return makeJwtKey(this.jwtSecret) }

  // ---------- account lookup ----------

  getAccount(
    handleOrDid: string,
    flags: { includeTakenDown?: boolean; includeDeactivated?: boolean } = {},
  ): ActorAccount | null {
    const { includeTakenDown = false, includeDeactivated = false } = flags
    let q = this.db.prepare(`
      SELECT a.did, a.handle, a.createdAt, a.takedownRef, a.deactivatedAt, a.deleteAfter,
             acc.email, acc.emailConfirmedAt, acc.invitesDisabled
      FROM actor a
      LEFT JOIN account acc ON acc.did = a.did
      WHERE (a.did = ? OR a.handle = ?)
    `)
    let row = q.get(handleOrDid, handleOrDid) as ActorAccount | undefined
    if (!row) return null
    if (!includeTakenDown && row.takedownRef) return null
    if (!includeDeactivated && row.deactivatedAt) return null
    return row
  }

  getAccountByEmail(
    email: string,
    flags: { includeTakenDown?: boolean; includeDeactivated?: boolean } = {},
  ): ActorAccount | null {
    const { includeTakenDown = false, includeDeactivated = false } = flags
    const row = this.db.prepare(`
      SELECT a.did, a.handle, a.createdAt, a.takedownRef, a.deactivatedAt, a.deleteAfter,
             acc.email, acc.emailConfirmedAt, acc.invitesDisabled
      FROM actor a
      JOIN account acc ON acc.did = a.did
      WHERE acc.email = ?
    `).get(email.toLowerCase()) as ActorAccount | undefined
    if (!row) return null
    if (!includeTakenDown && row.takedownRef) return null
    if (!includeDeactivated && row.deactivatedAt) return null
    return row
  }

  isAccountActivated(did: string): boolean {
    const row = this.getAccount(did, { includeDeactivated: true })
    if (!row) return false
    return !row.deactivatedAt
  }

  getAccountStatus(handleOrDid: string): AccountStatus {
    const row = this.getAccount(handleOrDid, { includeDeactivated: true, includeTakenDown: true })
    const { active, status } = formatAccountStatus(row)
    return active ? AccountStatus.Active : status!
  }

  // ---------- handle validation ----------

  normalizeAndValidateHandle(
    handle: string,
    opts: { did?: string; allowAnyValid?: boolean } = {},
  ): string {
    let normalized: string
    try {
      normalized = normalizeAndEnsureValidHandle(handle)
    } catch (err) {
      if (err instanceof InvalidHandleError) {
        throw new InvalidRequestError(err.message, 'InvalidHandle')
      }
      throw err
    }
    if (!isValidTld(normalized)) {
      throw new InvalidRequestError('Handle TLD is invalid or disallowed', 'InvalidHandle')
    }
    const isService = this.serviceHandleDomains.some((d) => normalized.endsWith(d))
    if (isService) {
      this._checkServiceHandleConstraints(normalized)
    } else {
      if (opts.did == null) {
        throw new InvalidRequestError('Not a supported handle domain', 'UnsupportedDomain')
      }
      // External handle: caller must verify DNS/HTTP resolution separately.
    }
    return normalized
  }

  private _checkServiceHandleConstraints(handle: string) {
    const domain = this.serviceHandleDomains.find((d) => handle.endsWith(d)) ?? ''
    const front = handle.slice(0, handle.length - domain.length)
    if (front.includes('.')) throw new InvalidRequestError('Invalid characters in handle', 'InvalidHandle')
    if (front.length < 3)  throw new InvalidRequestError('Handle too short', 'InvalidHandle')
    if (front.length > 18) throw new InvalidRequestError('Handle too long', 'InvalidHandle')
  }

  // ---------- create account ----------

  async createAccountAndSession(opts: {
    did: string
    handle: string
    email?: string
    password?: string
    repoCid: string
    repoRev: string
    inviteCode?: string
    deactivated?: boolean
  }) {
    const { accessJwt, refreshJwt } = await createTokens({
      did: opts.did,
      jwtKey: this.jwtKey,
      serviceDid: this.serviceDid,
      scope: AuthScope.Access,
    })
    await this._createAccount({ ...opts, refreshJwt })
    return { accessJwt, refreshJwt }
  }

  private async _createAccount(opts: {
    did: string
    handle: string
    email?: string
    password?: string
    repoCid: string
    repoRev: string
    inviteCode?: string
    deactivated?: boolean
    refreshJwt?: string
  }) {
    const { did, handle, email, password, repoCid, repoRev, inviteCode, deactivated = false, refreshJwt } = opts
    if (password && password.length > NEW_PASSWORD_MAX_LENGTH) {
      throw new InvalidRequestError('Password too long')
    }
    const passwordScrypt = password ? await genSaltAndHash(password) : undefined
    const now = new Date().toISOString()

    const insert = this.db.transaction(() => {
      if (inviteCode) this._assertInviteAvailable(inviteCode)

      // actor
      const actorResult = this.db.prepare(`
        INSERT OR IGNORE INTO actor (did, handle, createdAt, deactivatedAt, deleteAfter)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        did, handle, now,
        deactivated ? now : null,
        deactivated ? new Date(Date.now() + 3 * DAY).toISOString() : null,
      )
      if (actorResult.changes === 0) throw new UserAlreadyExistsError()

      // account (email + password)
      if (email && passwordScrypt) {
        const acctResult = this.db.prepare(`
          INSERT OR IGNORE INTO account (did, email, passwordScrypt) VALUES (?, ?, ?)
        `).run(did, email.toLowerCase(), passwordScrypt)
        if (acctResult.changes === 0) throw new UserAlreadyExistsError()
      }

      // invite code use
      if (inviteCode) {
        this.db.prepare(`INSERT OR IGNORE INTO invite_code_use (code, usedBy, usedAt) VALUES (?, ?, ?)`)
          .run(inviteCode, did, now)
      }

      // refresh token
      if (refreshJwt) {
        const decoded = decodeRefreshToken(refreshJwt)
        this.db.prepare(`
          INSERT OR IGNORE INTO refresh_token (id, did, expiresAt) VALUES (?, ?, ?)
        `).run(decoded.jti, did, new Date(decoded.exp * 1000).toISOString())
      }

      // repo root
      this.db.prepare(`
        INSERT OR REPLACE INTO repo_root (did, cid, rev, indexedAt) VALUES (?, ?, ?, ?)
      `).run(did, repoCid, repoRev, now)
    })
    insert()
  }

  // ---------- sessions ----------

  async createSession(
    did: string,
    appPassword: AppPassDescript | null,
    isSoftDeleted = false,
  ) {
    const { accessJwt, refreshJwt } = await createTokens({
      did,
      jwtKey: this.jwtKey,
      serviceDid: this.serviceDid,
      scope: formatScope(appPassword, isSoftDeleted),
    })
    if (!isSoftDeleted) {
      const payload = decodeRefreshToken(refreshJwt)
      this.db.prepare(`
        INSERT OR IGNORE INTO refresh_token (id, did, appPasswordName, expiresAt)
        VALUES (?, ?, ?, ?)
      `).run(payload.jti, did, appPassword?.name ?? null, new Date(payload.exp * 1000).toISOString())
    }
    return { accessJwt, refreshJwt }
  }

  async rotateRefreshToken(id: string): Promise<{ accessJwt: string; refreshJwt: string } | null> {
    const token = this.db.prepare(`
      SELECT rt.id, rt.did, rt.expiresAt, rt.nextId, ap.name as appPassName, ap.privileged
      FROM refresh_token rt
      LEFT JOIN app_password ap ON ap.did = rt.did AND ap.name = rt.appPasswordName
      WHERE rt.id = ?
    `).get(id) as { id: string; did: string; expiresAt: string; nextId: string | null; appPassName: string | null; privileged: number | null } | undefined

    if (!token) return null

    const now = new Date()
    // Clean up expired tokens for this user
    this.db.prepare(`DELETE FROM refresh_token WHERE did = ? AND expiresAt <= ?`)
      .run(token.did, now.toISOString())

    const prevExpiresAt = new Date(token.expiresAt)
    const graceExpiresAt = new Date(now.getTime() + 2 * HOUR)
    const expiresAt = graceExpiresAt < prevExpiresAt ? graceExpiresAt : prevExpiresAt
    if (expiresAt <= now) return null

    const nextId = token.nextId ?? getRefreshTokenId()
    const appPassword = token.appPassName
      ? { name: token.appPassName, privileged: token.privileged === 1 }
      : null

    const { accessJwt, refreshJwt } = await createTokens({
      did: token.did,
      jwtKey: this.jwtKey,
      serviceDid: this.serviceDid,
      scope: formatScope(appPassword),
      jti: nextId,
    })

    const newPayload = decodeRefreshToken(refreshJwt)

    const rotate = this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE refresh_token
        SET expiresAt = ?, nextId = ?
        WHERE id = ? AND (nextId IS NULL OR nextId = ?)
      `).run(expiresAt.toISOString(), nextId, id, nextId)
      if (updated.changes < 1) throw new Error('concurrent_refresh')

      this.db.prepare(`
        INSERT OR IGNORE INTO refresh_token (id, did, appPasswordName, expiresAt)
        VALUES (?, ?, ?, ?)
      `).run(newPayload.jti, token.did, appPassword?.name ?? null, new Date(newPayload.exp * 1000).toISOString())
    })

    try {
      rotate()
    } catch (err: any) {
      if (err?.message === 'concurrent_refresh') {
        return this.rotateRefreshToken(id)
      }
      throw err
    }

    return { accessJwt, refreshJwt }
  }

  revokeRefreshToken(id: string): boolean {
    const { changes } = this.db.prepare(`DELETE FROM refresh_token WHERE id = ?`).run(id)
    return changes > 0
  }

  // ---------- login ----------

  async login(opts: { identifier: string; password: string }) {
    const start = Date.now()
    try {
      const id = opts.identifier.toLowerCase()
      const user = id.includes('@')
        ? this.getAccountByEmail(id, { includeDeactivated: true, includeTakenDown: true })
        : this.getAccount(id, { includeDeactivated: true, includeTakenDown: true })

      if (!user) throw new AuthRequiredError('Invalid identifier or password')

      const isSoftDeleted = !!user.takedownRef
      const validAccountPass = await this._verifyAccountPassword(user.did, opts.password)
      let appPassword: AppPassDescript | null = null

      if (!validAccountPass) {
        if (isSoftDeleted) throw new AuthRequiredError('Invalid identifier or password')
        appPassword = await this._verifyAppPassword(user.did, opts.password)
        if (!appPassword) throw new AuthRequiredError('Invalid identifier or password')
      }

      return { user, appPassword, isSoftDeleted }
    } finally {
      await wait(350 - (Date.now() - start))
    }
  }

  private async _verifyAccountPassword(did: string, password: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT passwordScrypt FROM account WHERE did = ?`)
      .get(did) as { passwordScrypt: string } | undefined
    if (!row) return false
    return verifyPassword(password, row.passwordScrypt)
  }

  async verifyAccountPassword(did: string, password: string): Promise<boolean> {
    if (password.length > OLD_PASSWORD_MAX_LENGTH) return false
    return this._verifyAccountPassword(did, password)
  }

  private async _verifyAppPassword(did: string, password: string): Promise<AppPassDescript | null> {
    const hash = await hashAppPassword(did, password)
    const row = this.db.prepare(`
      SELECT name, privileged FROM app_password WHERE did = ? AND passwordScrypt = ?
    `).get(did, hash) as { name: string; privileged: number } | undefined
    if (!row) return null
    return { name: row.name, privileged: row.privileged === 1 }
  }

  // ---------- passwords ----------

  async createAppPassword(did: string, name: string, privileged: boolean) {
    const str = crypto.randomBytes(10).toString('base32').slice(0, 16)
    const chunks = [str.slice(0,4), str.slice(4,8), str.slice(8,12), str.slice(12,16)]
    const password = chunks.join('-')
    const passwordScrypt = await hashAppPassword(did, password)
    const createdAt = new Date().toISOString()
    try {
      this.db.prepare(`
        INSERT INTO app_password (did, name, passwordScrypt, createdAt, privileged)
        VALUES (?, ?, ?, ?, ?)
      `).run(did, name, passwordScrypt, createdAt, privileged ? 1 : 0)
    } catch {
      throw new InvalidRequestError('could not create app-specific password')
    }
    return { name, password, createdAt, privileged }
  }

  listAppPasswords(did: string): { name: string; createdAt: string; privileged: boolean }[] {
    const rows = this.db.prepare(`
      SELECT name, createdAt, privileged FROM app_password WHERE did = ? ORDER BY createdAt DESC
    `).all(did) as { name: string; createdAt: string; privileged: number }[]
    return rows.map((r) => ({ name: r.name, createdAt: r.createdAt, privileged: r.privileged === 1 }))
  }

  revokeAppPassword(did: string, name: string) {
    const del = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM app_password WHERE did = ? AND name = ?`).run(did, name)
      this.db.prepare(`DELETE FROM refresh_token WHERE did = ? AND appPasswordName = ?`).run(did, name)
    })
    del()
  }

  async updateAccountPassword(did: string, password: string) {
    const passwordScrypt = await genSaltAndHash(password)
    const update = this.db.transaction(() => {
      this.db.prepare(`UPDATE account SET passwordScrypt = ? WHERE did = ?`).run(passwordScrypt, did)
      this.db.prepare(`DELETE FROM email_token WHERE did = ? AND purpose = 'reset_password'`).run(did)
      this.db.prepare(`DELETE FROM refresh_token WHERE did = ?`).run(did)
    })
    update()
  }

  // ---------- email tokens ----------

  createEmailToken(did: string, purpose: EmailTokenPurpose): string {
    const token = _randomToken()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO email_token (purpose, did, token, requestedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(purpose, did) DO UPDATE SET token = excluded.token, requestedAt = excluded.requestedAt
    `).run(purpose, did, token, now)
    return token
  }

  assertValidEmailToken(did: string, purpose: EmailTokenPurpose, token: string) {
    const row = this.db.prepare(`
      SELECT requestedAt FROM email_token WHERE purpose = ? AND did = ? AND token = ?
    `).get(purpose, did, token.toUpperCase()) as { requestedAt: string } | undefined
    if (!row) throw new InvalidRequestError('Token is invalid', 'InvalidToken')
    if (!lessThanAgoMs(new Date(row.requestedAt), 15 * MINUTE)) {
      throw new InvalidRequestError('Token is expired', 'ExpiredToken')
    }
  }

  assertValidTokenAndFindDid(purpose: EmailTokenPurpose, token: string): string {
    const row = this.db.prepare(`
      SELECT did, requestedAt FROM email_token WHERE purpose = ? AND token = ?
    `).get(purpose, token.toUpperCase()) as { did: string; requestedAt: string } | undefined
    if (!row) throw new InvalidRequestError('Token is invalid', 'InvalidToken')
    if (!lessThanAgoMs(new Date(row.requestedAt), 15 * MINUTE)) {
      throw new InvalidRequestError('Token is expired', 'ExpiredToken')
    }
    return row.did
  }

  deleteEmailToken(did: string, purpose: EmailTokenPurpose) {
    this.db.prepare(`DELETE FROM email_token WHERE did = ? AND purpose = ?`).run(did, purpose)
  }

  deleteAllEmailTokens(did: string) {
    this.db.prepare(`DELETE FROM email_token WHERE did = ?`).run(did)
  }

  confirmEmail(did: string, token: string) {
    this.assertValidEmailToken(did, 'confirm_email', token)
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM email_token WHERE did = ? AND purpose = 'confirm_email'`).run(did)
      this.db.prepare(`UPDATE account SET emailConfirmedAt = ? WHERE did = ?`).run(now, did)
    })
    tx()
  }

  updateEmail(did: string, email: string) {
    const tx = this.db.transaction(() => {
      try {
        this.db.prepare(`UPDATE account SET email = ?, emailConfirmedAt = NULL WHERE did = ?`)
          .run(email.toLowerCase(), did)
      } catch (err: any) {
        if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UserAlreadyExistsError()
        throw err
      }
      this.db.prepare(`DELETE FROM email_token WHERE did = ?`).run(did)
    })
    tx()
  }

  async resetPassword(token: string, password: string) {
    const did = this.assertValidTokenAndFindDid('reset_password', token)
    await this.updateAccountPassword(did, password)
    return did
  }

  // ---------- invites ----------

  private _assertInviteAvailable(code: string) {
    const invite = this.db.prepare(`
      SELECT code, availableUses, disabled FROM invite_code WHERE code = ?
    `).get(code) as { code: string; availableUses: number; disabled: number } | undefined
    if (!invite || invite.disabled) {
      throw new InvalidRequestError('Provided invite code not available', 'InvalidInviteCode')
    }
    const uses = (this.db.prepare(`SELECT COUNT(*) as cnt FROM invite_code_use WHERE code = ?`)
      .get(code) as { cnt: number }).cnt
    if (invite.availableUses <= uses) {
      throw new InvalidRequestError('Provided invite code not available', 'InvalidInviteCode')
    }
  }

  ensureInviteIsAvailable(code: string) {
    this._assertInviteAvailable(code)
  }

  createInviteCodes(
    toCreate: { account: string; codes: string[] }[],
    useCount: number,
  ) {
    const now = new Date().toISOString()
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO invite_code (code, availableUses, disabled, forAccount, createdBy, createdAt)
      VALUES (?, ?, 0, ?, 'admin', ?)
    `)
    const tx = this.db.transaction(() => {
      for (const { account, codes } of toCreate) {
        for (const code of codes) {
          insert.run(code, useCount, account, now)
        }
      }
    })
    tx()
  }

  getAccountInviteCodes(did: string) {
    return this._getInviteCodes(did)
  }

  private _getInviteCodes(forAccount: string) {
    const rows = this.db.prepare(`
      SELECT code, availableUses as available, disabled, forAccount, createdBy, createdAt
      FROM invite_code WHERE forAccount = ?
    `).all(forAccount) as {
      code: string; available: number; disabled: number; forAccount: string; createdBy: string; createdAt: string
    }[]
    return rows.map((r) => {
      const uses = (this.db.prepare(`SELECT usedBy, usedAt FROM invite_code_use WHERE code = ?`)
        .all(r.code)) as { usedBy: string; usedAt: string }[]
      return { ...r, disabled: r.disabled === 1, uses }
    })
  }

  // ---------- account lifecycle ----------

  updateHandle(did: string, handle: string) {
    const result = this.db.prepare(`
      UPDATE actor SET handle = ? WHERE did = ? AND NOT EXISTS (
        SELECT 1 FROM actor WHERE handle = ? AND did != ?
      )
    `).run(handle, did, handle, did)
    if (result.changes < 1) throw new UserAlreadyExistsError()
  }

  deleteAccount(did: string) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM repo_root WHERE did = ?`).run(did)
      this.db.prepare(`DELETE FROM email_token WHERE did = ?`).run(did)
      this.db.prepare(`DELETE FROM refresh_token WHERE did = ?`).run(did)
      this.db.prepare(`DELETE FROM account WHERE did = ?`).run(did)
      this.db.prepare(`DELETE FROM actor WHERE did = ?`).run(did)
    })
    tx()
  }

  activateAccount(did: string) {
    this.db.prepare(`UPDATE actor SET deactivatedAt = NULL, deleteAfter = NULL WHERE did = ?`).run(did)
  }

  deactivateAccount(did: string, deleteAfter: string | null) {
    this.db.prepare(`UPDATE actor SET deactivatedAt = ?, deleteAfter = ? WHERE did = ?`)
      .run(new Date().toISOString(), deleteAfter, did)
  }

  takedownAccount(did: string, takedownRef: string) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE actor SET takedownRef = ? WHERE did = ?`).run(takedownRef, did)
      this.db.prepare(`DELETE FROM refresh_token WHERE did = ?`).run(did)
    })
    tx()
  }

  // ---------- repo root ----------

  updateRepoRoot(did: string, cid: string, rev: string) {
    this.db.prepare(`
      INSERT OR REPLACE INTO repo_root (did, cid, rev, indexedAt) VALUES (?, ?, ?, ?)
    `).run(did, cid, rev, new Date().toISOString())
  }

  getRepoRoot(did: string): { cid: string; rev: string } | null {
    return (this.db.prepare(`SELECT cid, rev FROM repo_root WHERE did = ?`).get(did) as any) ?? null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _randomToken(): string {
  const b = crypto.randomBytes(5).toString('hex').toUpperCase()
  return b.slice(0, 5) + '-' + b.slice(5, 10)
}

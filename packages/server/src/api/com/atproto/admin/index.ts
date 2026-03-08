/**
 * com.atproto.admin.* routes
 *
 * All admin endpoints require Basic auth (admin:password) unless noted.
 */
import { Router, Response } from 'express'
import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import type { AppContext } from '../../../../context.js'
import { formatAccountStatus, AccountStatus } from '../../../../account-manager/index.js'
import { logger } from '../../../../logger.js'
import { updatePlcHandle } from './plc-util.js'

function xErr(res: Response, err: unknown) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
  }
  if (err instanceof AuthRequiredError) {
    return res.status(401).json({ error: err.error ?? 'AuthRequired', message: err.message })
  }
  logger.error({ err }, 'admin handler error')
  return res.status(500).json({ error: 'InternalServerError', message: String(err) })
}

export function mountAdminRoutes(router: Router, ctx: AppContext) {

  // ── getAccountInfo ──────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.admin.getAccountInfo',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const did = req.query.did as string
        if (!did) throw new InvalidRequestError('did is required')
        const account = ctx.accountManager.getAccount(did, {
          includeDeactivated: true, includeTakenDown: true,
        })
        if (!account) throw new InvalidRequestError('Account not found', 'AccountNotFound')
        const { active, status } = formatAccountStatus(account)
        const root = ctx.accountManager.getRepoRoot(did)
        res.json({
          did: account.did,
          handle: account.handle,
          email: account.email,
          emailConfirmedAt: account.emailConfirmedAt,
          invitedBy: undefined,
          invites: ctx.accountManager.getAccountInviteCodes(did),
          invitesDisabled: !!account.invitesDisabled,
          indexedAt: account.createdAt,
          createdAt: account.createdAt,
          deactivatedAt: account.deactivatedAt,
          takedownRef: account.takedownRef,
          active,
          status,
          relatedRecords: [],
        })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── getAccountInfos ─────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.admin.getAccountInfos',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const dids = [req.query.dids].flat().filter(Boolean) as string[]
        if (dids.length === 0) throw new InvalidRequestError('dids is required')
        const infos = dids.map((did) => {
          const account = ctx.accountManager.getAccount(did, {
            includeDeactivated: true, includeTakenDown: true,
          })
          if (!account) return null
          const { active, status } = formatAccountStatus(account)
          return { did: account.did, handle: account.handle, email: account.email, active, status }
        }).filter(Boolean)
        res.json({ infos })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── searchAccounts ──────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.admin.searchAccounts',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const email = req.query.email as string | undefined
        const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100)
        const cursor = req.query.cursor as string | undefined

        let sql = `
          SELECT a.did, a.handle, a.createdAt, a.takedownRef, a.deactivatedAt,
                 acc.email, acc.emailConfirmedAt
          FROM actor a
          LEFT JOIN account acc ON acc.did = a.did
          WHERE 1=1
        `
        const args: unknown[] = []
        if (email) { sql += ` AND acc.email LIKE ?`; args.push(`%${email.toLowerCase()}%`) }
        if (cursor) { sql += ` AND a.createdAt > ?`; args.push(cursor) }
        sql += ` ORDER BY a.createdAt ASC LIMIT ?`
        args.push(limit)

        const rows = ctx.db.prepare(sql).all(...args) as any[]
        res.json({ accounts: rows, cursor: rows.at(-1)?.createdAt })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── updateAccountHandle ─────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.updateAccountHandle',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { did, handle } = req.body ?? {}
        if (!did || !handle) throw new InvalidRequestError('did and handle are required')

        const normalized = ctx.accountManager.normalizeAndValidateHandle(handle, {
          did, allowAnyValid: true,
        })

        const existing = ctx.accountManager.getAccount(normalized, { includeDeactivated: true, includeTakenDown: true })
        if (existing && existing.did !== did) {
          throw new InvalidRequestError(`Handle already taken: ${normalized}`)
        }

        if (!existing) {
          // Update PLC if did:plc
          if (did.startsWith('did:plc:')) {
            try {
              await updatePlcHandle(ctx, did, normalized)
            } catch (err) {
              if (err instanceof InvalidRequestError) throw err
              logger.warn({ err, did }, 'admin.updateAccountHandle: PLC update failed')
            }
          }
          ctx.accountManager.updateHandle(did, normalized)
        }

        try {
          await ctx.sequencer.sequenceIdentityEvt(did, normalized)
        } catch (err) {
          logger.error({ err, did, normalized }, 'failed to sequence handle update')
        }

        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── updateAccountEmail ──────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.updateAccountEmail',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { account: did, email } = req.body ?? {}
        if (!did || !email) throw new InvalidRequestError('account (did) and email are required')
        ctx.accountManager.updateEmail(did, email)
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── updateAccountPassword ───────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.updateAccountPassword',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { did, password } = req.body ?? {}
        if (!did || !password) throw new InvalidRequestError('did and password are required')
        await ctx.accountManager.updateAccountPassword(did, password)
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── deleteAccount ───────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.deleteAccount',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { did } = req.body ?? {}
        if (!did) throw new InvalidRequestError('did is required')
        ctx.accountManager.deleteAccount(did)
        try {
          await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Deleted)
        } catch (err) {
          logger.error({ err, did }, 'failed to sequence account delete event')
        }
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── disableAccountInvites ───────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.disableAccountInvites',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { account: did } = req.body ?? {}
        if (!did) throw new InvalidRequestError('account (did) is required')
        ctx.db.prepare(`UPDATE account SET invitesDisabled = 1 WHERE did = ?`).run(did)
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── enableAccountInvites ────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.enableAccountInvites',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { account: did } = req.body ?? {}
        if (!did) throw new InvalidRequestError('account (did) is required')
        ctx.db.prepare(`UPDATE account SET invitesDisabled = 0 WHERE did = ?`).run(did)
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── disableInviteCodes ──────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.disableInviteCodes',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { codes = [], accounts = [] } = req.body ?? {}
        const stmt = ctx.db.prepare(`UPDATE invite_code SET disabled = 1 WHERE code = ?`)
        const stmtAcc = ctx.db.prepare(`UPDATE invite_code SET disabled = 1 WHERE forAccount = ?`)
        const tx = ctx.db.transaction(() => {
          for (const code of codes) stmt.run(code)
          for (const acc of accounts) stmtAcc.run(acc)
        })
        tx()
        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )

  // ── getInviteCodes ──────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.admin.getInviteCodes',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const sort = (req.query.sort as string) ?? 'recent'
        const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10), 500)
        const cursor = req.query.cursor as string | undefined

        let sql = `
          SELECT ic.code, ic.availableUses, ic.disabled, ic.forAccount, ic.createdBy, ic.createdAt
          FROM invite_code ic
          WHERE 1=1
        `
        const args: unknown[] = []
        if (cursor) { sql += ` AND ic.createdAt > ?`; args.push(cursor) }
        sql += sort === 'usage'
          ? ` ORDER BY (SELECT COUNT(*) FROM invite_code_use WHERE code = ic.code) DESC, ic.createdAt DESC`
          : ` ORDER BY ic.createdAt DESC`
        sql += ` LIMIT ?`
        args.push(limit)

        const rows = ctx.db.prepare(sql).all(...args) as any[]
        const codes = rows.map((r) => {
          const uses = ctx.db.prepare(`SELECT usedBy, usedAt FROM invite_code_use WHERE code = ?`).all(r.code) as any[]
          return { ...r, disabled: r.disabled === 1, uses }
        })
        res.json({ codes, cursor: rows.at(-1)?.createdAt })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── sendEmail ───────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.admin.sendEmail',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
        const { recipientDid, subject, content } = req.body ?? {}
        if (!recipientDid || !subject || !content) {
          throw new InvalidRequestError('recipientDid, subject, and content are required')
        }
        const account = ctx.accountManager.getAccount(recipientDid, {
          includeDeactivated: true, includeTakenDown: true,
        })
        if (!account?.email) throw new InvalidRequestError('Could not find email for account')
        await ctx.mailer.sendAdminEmail({ subject, content }, { to: account.email })
        res.json({ sent: true })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── updateSubjectStatus ─────────────────────────────────────────────────
  // Handles takedown of repos, records, and blobs.
  router.post('/xrpc/com.atproto.admin.updateSubjectStatus',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { subject, takedown, deactivated } = req.body ?? {}
        if (!subject) throw new InvalidRequestError('subject is required')

        const subjectType = subject.$type as string
        if (subjectType === 'com.atproto.admin.defs#repoRef') {
          const did = subject.did as string
          if (takedown) {
            const ref = takedown.ref as string ?? new Date().toISOString()
            ctx.accountManager.takedownAccount(did, ref)
            await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Takendown)
          }
          if (deactivated) {
            if (deactivated.applied) {
              ctx.accountManager.deactivateAccount(did, null)
              await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Deactivated)
            } else {
              ctx.accountManager.activateAccount(did)
              await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Active)
            }
          }
          const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
          const { active, status } = formatAccountStatus(account)
          res.json({ subject, takedown, active, status })
        } else if (subjectType === 'com.atproto.repo.strongRef') {
          // Record takedown
          if (takedown) {
            const uri = new AtUri(subject.uri)
            const ref = takedown.ref ?? new Date().toISOString()
            ctx.db.prepare(`UPDATE record SET takedownRef = ? WHERE uri = ?`).run(ref, uri.toString())
          }
          res.json({ subject, takedown })
        } else if (subjectType === 'com.atproto.admin.defs#repoBlobRef') {
          // Blob takedown
          if (takedown) {
            const ref = takedown.ref ?? new Date().toISOString()
            ctx.db.prepare(`UPDATE blob SET takedownRef = ? WHERE did = ? AND cid = ?`)
              .run(ref, subject.did, subject.cid)
            await ctx.blobstore.quarantine(CID.parse(subject.cid)).catch(() => {})
          }
          res.json({ subject, takedown })
        } else {
          throw new InvalidRequestError(`Unsupported subject type: ${subjectType}`)
        }
      } catch (err) { xErr(res, err) }
    },
  )

  // ── getSubjectStatus ────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.admin.getSubjectStatus',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const did = req.query.did as string | undefined
        const uri = req.query.uri as string | undefined
        const blob = req.query.blob as string | undefined

        if (did) {
          const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
          const { active, status } = formatAccountStatus(account ?? null)
          res.json({
            subject: { $type: 'com.atproto.admin.defs#repoRef', did },
            takedown: account?.takedownRef ? { applied: true, ref: account.takedownRef } : { applied: false },
          })
        } else if (uri) {
          const row = ctx.db.prepare(`SELECT takedownRef FROM record WHERE uri = ?`).get(uri) as { takedownRef: string | null } | undefined
          res.json({
            subject: { $type: 'com.atproto.repo.strongRef', uri },
            takedown: row?.takedownRef ? { applied: true, ref: row.takedownRef } : { applied: false },
          })
        } else if (blob && did) {
          const row = ctx.db.prepare(`SELECT takedownRef FROM blob WHERE did = ? AND cid = ?`).get(did, blob) as { takedownRef: string | null } | undefined
          res.json({
            subject: { $type: 'com.atproto.admin.defs#repoBlobRef', did, cid: blob },
            takedown: row?.takedownRef ? { applied: true, ref: row.takedownRef } : { applied: false },
          })
        } else {
          throw new InvalidRequestError('did, uri, or (did + blob) is required')
        }
      } catch (err) { xErr(res, err) }
    },
  )
}

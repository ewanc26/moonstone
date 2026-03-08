import { Router, Request, Response } from 'express'
import { isEmailValid } from '@hapi/address'
import { isDisposableEmail } from 'disposable-email-domains-js'
import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { AccountStatus, formatAccountStatus, INVALID_HANDLE } from '../../../../account-manager/index.js'
import { logger } from '../../../../logger.js'

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function xrpcErr(res: Response, err: unknown) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
  }
  if (err instanceof AuthRequiredError) {
    return res.status(401).json({ error: err.error ?? 'AuthRequired', message: err.message })
  }
  const msg = err instanceof Error ? err.message : 'Internal Server Error'
  return res.status(500).json({ error: 'InternalServerError', message: msg })
}

// Generate invite code like: hostname-xxxxx-xxxxx
function genInvCode(hostname: string): string {
  const part = () => Math.random().toString(36).slice(2, 7).padStart(5, '0')
  return hostname.replaceAll('.', '-') + '-' + part() + '-' + part()
}

// ---------------------------------------------------------------------------
// com.atproto.server routes
// ---------------------------------------------------------------------------

export function mountServerRoutes(router: Router, ctx: AppContext) {

  // ── describeServer ──────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.server.describeServer', (_req, res) => {
    res.json({
      did: ctx.cfg.service.did,
      availableUserDomains: ctx.cfg.identity.serviceHandleDomains,
      inviteCodeRequired: false,
      links: {},
      contact: {},
    })
  })

  // ── createAccount ────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.createAccount', async (req, res) => {
    try {
      const {
        handle,
        email,
        password,
        inviteCode,
        recoveryKey,
        // Bring-your-own-DID / migration fields
        did: inputDid,
      } = req.body ?? {}

      if (!handle) throw new InvalidRequestError('handle is required')

      const normalizedHandle = ctx.accountManager.normalizeAndValidateHandle(handle)

      // ── did:web native account creation ────────────────────────────────────
      // If the caller provides a did:web DID, we verify the DID document
      // already resolves and its #atproto_pds service points to this PDS.
      // No PLC submission; the domain owner proves control via DNS + HTTPS.
      // The account is created active — no migration dance needed.
      if (inputDid && inputDid.startsWith('did:web:')) {
        if (!email)    throw new InvalidRequestError('email is required for did:web account creation')
        if (!password) throw new InvalidRequestError('password is required for did:web account creation')

        // Verify DID document resolves and points to this PDS
        let didDoc: Record<string, unknown> | undefined
        try {
          const resolved = await ctx.idResolver.did.resolve(inputDid)
          if (!resolved) throw new Error('DID document not found')
          didDoc = resolved as Record<string, unknown>
        } catch (e) {
          throw new InvalidRequestError(
            `could not resolve did:web DID document for ${inputDid}: ${(e as Error).message}`,
          )
        }

        // Confirm the DID doc's #atproto_pds service endpoint matches this PDS
        const services: any[] = (didDoc['service'] as any[]) ?? []
        const pdsSvc = services.find(
          (s) => s.id === '#atproto_pds' || s.id === `${inputDid}#atproto_pds`,
        )
        if (!pdsSvc) {
          throw new InvalidRequestError(
            `did:web DID document for ${inputDid} has no #atproto_pds service entry`,
          )
        }
        const declaredEndpoint: string = pdsSvc.serviceEndpoint ?? ''
        if (declaredEndpoint.replace(/\/$/, '') !== ctx.cfg.service.publicUrl.replace(/\/$/, '')) {
          throw new InvalidRequestError(
            `did:web DID document declares PDS at ${declaredEndpoint}, but this server is ${ctx.cfg.service.publicUrl}`,
          )
        }

        if (ctx.accountManager.getAccountByEmail(email)) {
          throw new InvalidRequestError(`Email already taken: ${email}`)
        }

        const signingKey = await ctx.keyStore.getOrCreateKeypair(inputDid)
        const commit = await ctx.actorStore.transact(inputDid, signingKey, (txn) =>
          txn.createRepo([])
        )
        const { accessJwt, refreshJwt } = await ctx.accountManager.createAccountAndSession({
          did: inputDid,
          handle: normalizedHandle,
          email,
          password,
          repoCid: commit.cid.toString(),
          repoRev: commit.rev,
          inviteCode,
        })
        ctx.accountManager.updateRepoRoot(inputDid, commit.cid.toString(), commit.rev)

        await ctx.sequencer.sequenceIdentityEvt(inputDid, normalizedHandle)
        await ctx.sequencer.sequenceAccountEvt(inputDid, AccountStatus.Active)
        await ctx.sequencer.sequenceCommit(inputDid, commit)
        void ctx.crawlers.notifyOfUpdate()

        return res.json({
          handle: normalizedHandle,
          did: inputDid,
          didDoc,
          accessJwt,
          refreshJwt,
        })
      }

      // ── Bring-your-own-DID (migration / deactivated-create) path ──────────
      // When a non-did:web `did` is provided the caller is migrating an
      // existing account to this PDS.  We create it in a deactivated state;
      // the client calls activateAccount once migration is complete.
      if (inputDid) {
        const signingKey = await ctx.keyStore.getOrCreateKeypair(inputDid)
        const commit = await ctx.actorStore.transact(inputDid, signingKey, (txn) =>
          txn.createRepo([])
        )
        const { accessJwt, refreshJwt } = await ctx.accountManager.createAccountAndSession({
          did: inputDid,
          handle: normalizedHandle,
          email: email ?? undefined,
          password: password ?? undefined,
          repoCid: commit.cid.toString(),
          repoRev: commit.rev,
          inviteCode,
          deactivated: true,
        })
        ctx.accountManager.updateRepoRoot(inputDid, commit.cid.toString(), commit.rev)
        return res.json({
          handle: normalizedHandle,
          did: inputDid,
          accessJwt,
          refreshJwt,
        })
      }

      // ── Normal (local) account creation ───────────────────────────────────
      if (!email)    throw new InvalidRequestError('email is required')
      if (!password) throw new InvalidRequestError('password is required')

      // Validate email format and reject known disposable providers
      if (!isEmailValid(email)) {
        throw new InvalidRequestError(
          'This email address is not supported, please use a different email.',
        )
      }
      if (isDisposableEmail(email)) {
        throw new InvalidRequestError(
          'This email address is not supported, please use a different email.',
        )
      }

      // Check handle + email uniqueness
      if (ctx.accountManager.getAccount(normalizedHandle)) {
        throw new InvalidRequestError(`Handle already taken: ${normalizedHandle}`)
      }
      if (ctx.accountManager.getAccountByEmail(email)) {
        throw new InvalidRequestError(`Email already taken: ${email}`)
      }

      // Create signing keypair
      const signingKey = await ctx.keyStore.getOrCreateKeypair(`pending-${Date.now()}`)

      // Build rotation keys — PLC rotation key is mandatory; user's recovery key is optional
      const rotationKeys = [ctx.plcRotationKey.did()]
      if (recoveryKey) rotationKeys.unshift(recoveryKey)

      // Create DID:PLC
      const plc = await import('@did-plc/lib')
      const { did: newDid, op: plcOp } = await plc.createOp({
        signingKey: signingKey.did(),
        rotationKeys,
        handle: normalizedHandle,
        pds: ctx.cfg.service.publicUrl,
        signer: ctx.plcRotationKey,
      })

      // Submit PLC op to registry
      const plcResp = await fetch(`${ctx.cfg.identity.plcUrl}/${newDid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plcOp),
        signal: AbortSignal.timeout(10_000),
      })
      if (!plcResp.ok) {
        const body = await plcResp.text()
        logger.error({ status: plcResp.status, body }, 'failed to submit PLC op')
        throw new InvalidRequestError(`Failed to create DID: ${body}`)
      }

      // Promote the provisional keypair to permanent ownership of this DID
      await ctx.keyStore.promoteOrAssignKeypair(signingKey, newDid)

      // Resolve DID document (best-effort; not fatal if unavailable immediately)
      let didDoc: Record<string, unknown> | undefined
      try {
        const resolved = await ctx.idResolver.did.resolve(newDid)
        if (resolved) didDoc = resolved as Record<string, unknown>
      } catch {
        // DID doc may not be immediately propagated — that's fine
      }

      // Create empty genesis repo commit
      const commit = await ctx.actorStore.transact(newDid, signingKey, (txn) =>
        txn.createRepo([])
      )

      const { accessJwt, refreshJwt } = await ctx.accountManager.createAccountAndSession({
        did: newDid,
        handle: normalizedHandle,
        email,
        password,
        repoCid: commit.cid.toString(),
        repoRev: commit.rev,
        inviteCode,
      })

      // Sequence events
      await ctx.sequencer.sequenceIdentityEvt(newDid, normalizedHandle)
      await ctx.sequencer.sequenceAccountEvt(newDid, AccountStatus.Active)
      await ctx.sequencer.sequenceCommit(newDid, commit)
      ctx.accountManager.updateRepoRoot(newDid, commit.cid.toString(), commit.rev)

      // Notify crawlers
      void ctx.crawlers.notifyOfUpdate()

      res.json({
        handle: normalizedHandle,
        did: newDid,
        ...(didDoc ? { didDoc } : {}),
        accessJwt,
        refreshJwt,
      })
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── createSession ─────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.createSession', async (req, res) => {
    try {
      const { identifier, password } = req.body ?? {}
      if (!identifier || !password) {
        throw new InvalidRequestError('identifier and password are required')
      }
      const { user, appPassword, isSoftDeleted } = await ctx.accountManager.login({ identifier, password })

      if (!req.body.allowTakendown && isSoftDeleted) {
        throw new AuthRequiredError('Account has been taken down', 'AccountTakedown')
      }

      const [{ accessJwt, refreshJwt }] = await Promise.all([
        ctx.accountManager.createSession(user.did, appPassword, isSoftDeleted),
      ])

      const { status, active } = formatAccountStatus(user)

      res.json({
        accessJwt,
        refreshJwt,
        did: user.did,
        handle: user.handle ?? INVALID_HANDLE,
        email: user.email ?? undefined,
        emailConfirmed: !!user.emailConfirmedAt,
        active,
        status,
      })
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── getSession ────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.server.getSession', ctx.authVerifier.accessToken, async (req, res) => {
    try {
      const did = res.locals.auth.credentials.did
      const user = ctx.accountManager.getAccount(did, { includeDeactivated: true })
      if (!user) throw new InvalidRequestError(`Could not find user info for account: ${did}`)

      const { status, active } = formatAccountStatus(user)
      res.json({
        did: user.did,
        handle: user.handle ?? INVALID_HANDLE,
        email: user.email ?? undefined,
        emailConfirmed: !!user.emailConfirmedAt,
        active,
        status,
      })
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── refreshSession ────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.refreshSession', ctx.authVerifier.refreshToken, async (req, res) => {
    try {
      const { did, tokenId } = res.locals.auth.credentials
      const user = ctx.accountManager.getAccount(did, {
        includeDeactivated: true,
        includeTakenDown: true,
      })
      if (!user) throw new InvalidRequestError(`Could not find user info for account: ${did}`)
      if (user.takedownRef) throw new AuthRequiredError('Account has been taken down', 'AccountTakedown')

      const rotated = await ctx.accountManager.rotateRefreshToken(tokenId)
      if (!rotated) throw new InvalidRequestError('Token has been revoked', 'ExpiredToken')

      const { status, active } = formatAccountStatus(user)
      res.json({
        accessJwt: rotated.accessJwt,
        refreshJwt: rotated.refreshJwt,
        did: user.did,
        handle: user.handle ?? INVALID_HANDLE,
        email: user.email ?? undefined,
        emailConfirmed: !!user.emailConfirmedAt,
        active,
        status,
      })
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── deleteSession ────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.deleteSession', ctx.authVerifier.refreshToken, async (req, res) => {
    try {
      const { tokenId } = res.locals.auth.credentials
      ctx.accountManager.revokeRefreshToken(tokenId)
      res.status(200).end()
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── createAppPassword ─────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.createAppPassword',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const { name, privileged = false } = req.body ?? {}
        if (!name) throw new InvalidRequestError('name is required')
        const result = await ctx.accountManager.createAppPassword(
          res.locals.auth.credentials.did, name, !!privileged,
        )
        res.json(result)
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── listAppPasswords ──────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.server.listAppPasswords',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const passwords = ctx.accountManager.listAppPasswords(res.locals.auth.credentials.did)
        res.json({ passwords })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── revokeAppPassword ─────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.revokeAppPassword',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const { name } = req.body ?? {}
        if (!name) throw new InvalidRequestError('name is required')
        ctx.accountManager.revokeAppPassword(res.locals.auth.credentials.did, name)
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── requestEmailConfirmation ──────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.requestEmailConfirmation',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
        const did = res.locals.auth.credentials.did
        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
        if (!account) throw new InvalidRequestError('account not found')
        if (!account.email) throw new InvalidRequestError('account does not have an email address')
        const token = ctx.accountManager.createEmailToken(did, 'confirm_email')
        await ctx.mailer.sendConfirmEmail({ token }, { to: account.email })
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── confirmEmail ──────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.confirmEmail',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { token, email } = req.body ?? {}
        if (!token || !email) throw new InvalidRequestError('token and email are required')
        const user = ctx.accountManager.getAccount(did, { includeDeactivated: true })
        if (!user) throw new InvalidRequestError('user not found', 'AccountNotFound')
        if (user.email !== email.toLowerCase()) throw new InvalidRequestError('invalid email', 'InvalidEmail')
        ctx.accountManager.confirmEmail(did, token)
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── requestEmailUpdate ────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.requestEmailUpdate',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
        const did = res.locals.auth.credentials.did
        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
        if (!account) throw new InvalidRequestError('account not found')
        if (!account.email) throw new InvalidRequestError('account does not have an email address')
        const tokenRequired = !!account.emailConfirmedAt
        if (tokenRequired) {
          const token = ctx.accountManager.createEmailToken(did, 'update_email')
          await ctx.mailer.sendUpdateEmail({ token }, { to: account.email })
        }
        res.json({ tokenRequired })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── updateEmail ───────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.updateEmail',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { email, token } = req.body ?? {}
        if (!email) throw new InvalidRequestError('email is required')
        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true })
        if (!account) throw new InvalidRequestError('account not found')
        if (account.emailConfirmedAt) {
          if (!token) throw new InvalidRequestError('confirmation token required', 'TokenRequired')
          ctx.accountManager.assertValidEmailToken(did, 'update_email', token)
        }
        try {
          ctx.accountManager.updateEmail(did, email)
        } catch (err: any) {
          if (err?.constructor?.name === 'UserAlreadyExistsError') {
            throw new InvalidRequestError('This email address is already in use, please use a different email.')
          }
          throw err
        }
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── requestPasswordReset ──────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.requestPasswordReset', async (req, res) => {
    try {
      if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
      const { email } = req.body ?? {}
      if (!email) throw new InvalidRequestError('email is required')
      const account = ctx.accountManager.getAccountByEmail(email, {
        includeDeactivated: true, includeTakenDown: true,
      })
      if (!account?.email) {
        // Silently succeed — don't leak account existence
        return res.status(200).end()
      }
      const token = ctx.accountManager.createEmailToken(account.did, 'reset_password')
      await ctx.mailer.sendResetPassword({ handle: account.handle ?? account.email, token }, { to: account.email })
      res.status(200).end()
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── resetPassword ─────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.resetPassword', async (req, res) => {
    try {
      const { token, password } = req.body ?? {}
      if (!token || !password) throw new InvalidRequestError('token and password are required')
      await ctx.accountManager.resetPassword(token, password)
      res.status(200).end()
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── requestAccountDelete ──────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.requestAccountDelete',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        if (!ctx.mailer) throw new InvalidRequestError('Email service not configured')
        const did = res.locals.auth.credentials.did
        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
        if (!account) throw new InvalidRequestError('account not found')
        if (!account.email) throw new InvalidRequestError('account does not have an email address')
        const token = ctx.accountManager.createEmailToken(did, 'delete_account')
        await ctx.mailer.sendAccountDelete({ token }, { to: account.email })
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── deleteAccount ─────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.deleteAccount', async (req, res) => {
    try {
      const { did, password, token } = req.body ?? {}
      if (!did || !password || !token) {
        throw new InvalidRequestError('did, password, and token are required')
      }
      const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
      if (!account) throw new InvalidRequestError('account not found')
      const validPass = await ctx.accountManager.verifyAccountPassword(did, password)
      if (!validPass) throw new AuthRequiredError('Invalid did or password')
      ctx.accountManager.assertValidEmailToken(did, 'delete_account', token)
      ctx.accountManager.deleteAccount(did)
      res.status(200).end()
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── checkAccountStatus ────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.server.checkAccountStatus',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const activated = ctx.accountManager.isAccountActivated(did)
        const repoRoot = ctx.accountManager.getRepoRoot(did)
        const recordCount = ctx.db.prepare(`SELECT COUNT(*) as cnt FROM record WHERE did = ?`).get(did) as { cnt: number }
        const blobCount  = ctx.db.prepare(`SELECT COUNT(*) as cnt FROM blob    WHERE did = ?`).get(did) as { cnt: number }
        res.json({
          activated,
          validDid: true,
          repoCommit: repoRoot?.cid ?? '',
          repoRev: repoRoot?.rev ?? '',
          repoBlocks: 0,
          indexedRecords: recordCount.cnt,
          privateStateValues: 0,
          expectedBlobs: blobCount.cnt,
          importedBlobs: blobCount.cnt,
        })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── activateAccount ───────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.activateAccount',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        ctx.accountManager.activateAccount(did)
        // Sequence identity + account events so relays notice the activation
        await ctx.sequencer.sequenceIdentityEvt(did)
        await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Active)
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── deactivateAccount ─────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.deactivateAccount',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const deleteAfter = req.body?.deleteAfter ?? null
        ctx.accountManager.deactivateAccount(did, deleteAfter)
        await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Deactivated)
        res.status(200).end()
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── createInviteCode (admin) ──────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.createInviteCode',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { useCount = 1, forAccount = 'admin' } = req.body ?? {}
        const code = genInvCode(ctx.cfg.service.hostname)
        ctx.accountManager.createInviteCodes([{ account: forAccount, codes: [code] }], useCount)
        res.json({ code })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── createInviteCodes (admin) ─────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.createInviteCodes',
    ctx.authVerifier.adminToken,
    async (req, res) => {
      try {
        const { codeCount = 1, useCount = 1, forAccounts = ['admin'] } = req.body ?? {}
        const accountCodes = (forAccounts as string[]).map((account) => ({
          account,
          codes: Array.from({ length: codeCount }, () => genInvCode(ctx.cfg.service.hostname)),
        }))
        ctx.accountManager.createInviteCodes(accountCodes, useCount)
        res.json({ codes: accountCodes })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── getAccountInviteCodes ─────────────────────────────────────────────
  router.get('/xrpc/com.atproto.server.getAccountInviteCodes',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const includeUsed = req.query.includeUsed !== 'false'
        const account = ctx.accountManager.getAccount(did)
        if (!account) throw new InvalidRequestError('Account not found', 'NotFound')

        let codes = ctx.accountManager.getAccountInviteCodes(did)
        if (!includeUsed) {
          codes = codes.filter((c) => !c.disabled && c.uses.length < c.available)
        }
        res.json({ codes })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )

  // ── reserveSigningKey ─────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.server.reserveSigningKey', async (req, res) => {
    try {
      const { did } = req.body ?? {}
      const keypair = await ctx.keyStore.reserveKeypair(did)
      res.json({ signingKey: keypair.did() })
    } catch (err) {
      xrpcErr(res, err)
    }
  })

  // ── getServiceAuth ────────────────────────────────────────────────────
  // Returns a service JWT signed by the account's signing keypair.
  router.get('/xrpc/com.atproto.server.getServiceAuth',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const { HOUR } = await import('@atproto/common')
        const { createServiceJwt } = await import('@atproto/xrpc-server')
        const did = res.locals.auth.credentials.did
        const aud = req.query.aud as string | undefined
        const lxm = req.query.lxm as string | undefined
        const expStr = req.query.exp as string | undefined
        const exp = expStr ? parseInt(expStr, 10) : undefined

        if (!aud) throw new InvalidRequestError('aud is required')

        if (exp !== undefined) {
          const diff = exp * 1000 - Date.now()
          if (diff < 0) throw new InvalidRequestError('expiration is in past', 'BadExpiration')
          if (diff > HOUR) throw new InvalidRequestError('cannot request a token with an expiration more than an hour in the future', 'BadExpiration')
        }

        const keypair = await ctx.keyStore.getOrCreateKeypair(did)
        const token = await createServiceJwt({ iss: did, aud, exp, lxm: lxm ?? null, keypair })
        res.json({ token })
      } catch (err) {
        xrpcErr(res, err)
      }
    },
  )
}

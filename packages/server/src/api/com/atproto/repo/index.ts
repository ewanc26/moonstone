import { Router } from 'express'
import { CID } from 'multiformats/cid'
import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { AppContext } from '../../../../context.js'
import { INVALID_HANDLE, formatAccountStatus } from '../../../../account-manager/index.js'
import {
  prepareCreate, prepareUpdate, prepareDelete,
  findBlobRefs,
  BadCommitSwapError, BadRecordSwapError, InvalidRecordError,
} from '../../../../repo/index.js'
import { logger } from '../../../../logger.js'

function xErr(res: any, err: unknown) {
  if (err instanceof InvalidRequestError) {
    return res.status(400).json({ error: err.error ?? 'InvalidRequest', message: err.message })
  }
  if (err instanceof AuthRequiredError) {
    return res.status(401).json({ error: err.error ?? 'AuthRequired', message: err.message })
  }
  logger.error({ err }, 'repo handler error')
  return res.status(500).json({ error: 'InternalServerError', message: String(err) })
}

async function resolveRepoToDid(ctx: AppContext, repo: string): Promise<string | null> {
  if (repo.startsWith('did:')) return repo
  const account = ctx.accountManager.getAccount(repo)
  return account?.did ?? null
}

export function mountRepoRoutes(router: Router, ctx: AppContext) {

  // ── describeRepo ──────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.repo.describeRepo', async (req, res) => {
    try {
      const repo = req.query.repo as string
      if (!repo) throw new InvalidRequestError('repo is required')

      const did = await resolveRepoToDid(ctx, repo)
      if (!did) throw new InvalidRequestError(`Could not find repo: ${repo}`)

      const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
      if (!account || account.takedownRef) throw new InvalidRequestError(`Repo not available: ${repo}`)

      let didDoc: Record<string, unknown>
      try {
        didDoc = await ctx.idResolver.did.ensureResolve(did)
      } catch (err) {
        throw new InvalidRequestError(`Could not resolve DID: ${err}`)
      }

      const reader = ctx.actorStore.reader(did)
      const collections = reader.record.listCollections(did)
      const handleFromDoc = extractHandle(didDoc)
      const handleIsCorrect = handleFromDoc === account.handle

      res.json({
        handle: account.handle ?? INVALID_HANDLE,
        did,
        didDoc,
        collections,
        handleIsCorrect,
      })
    } catch (err) { xErr(res, err) }
  })

  // ── getRecord ──────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.repo.getRecord', async (req, res) => {
    try {
      const { repo, collection, rkey, cid } = req.query as Record<string, string>
      if (!repo || !collection || !rkey) throw new InvalidRequestError('repo, collection, and rkey are required')

      const did = await resolveRepoToDid(ctx, repo)
      if (!did) throw new InvalidRequestError(`Could not find repo: ${repo}`)

      const uri = AtUri.make(did, collection, rkey)
      const reader = ctx.actorStore.reader(did)
      const record = reader.record.getRecord(uri, cid ?? null)

      if (!record || record.takedownRef) {
        throw new InvalidRequestError(`Could not locate record: ${uri}`, 'RecordNotFound')
      }

      res.json({ uri: uri.toString(), cid: record.cid, value: record.value })
    } catch (err) { xErr(res, err) }
  })

  // ── listRecords ────────────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.repo.listRecords', async (req, res) => {
    try {
      const repo = req.query.repo as string
      const collection = req.query.collection as string
      const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100)
      const cursor = req.query.cursor as string | undefined
      const reverse = req.query.reverse === 'true'

      if (!repo || !collection) throw new InvalidRequestError('repo and collection are required')

      const did = await resolveRepoToDid(ctx, repo)
      if (!did) throw new InvalidRequestError(`Could not find repo: ${repo}`)

      const reader = ctx.actorStore.reader(did)
      const records = reader.record.listRecordsForCollection({ did, collection, limit, reverse, cursor })
      const lastUri = records.at(-1)?.uri ? new AtUri(records.at(-1)!.uri) : undefined

      res.json({ records, cursor: lastUri?.rkey })
    } catch (err) { xErr(res, err) }
  })

  // ── createRecord ──────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.createRecord',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { repo, collection, rkey, record, swapCommit, validate } = req.body ?? {}

        if (!repo || !collection || !record) {
          throw new InvalidRequestError('repo, collection, and record are required')
        }
        const repoDid = await resolveRepoToDid(ctx, repo)
        if (repoDid !== did) throw new AuthRequiredError()

        const account = ctx.accountManager.getAccount(did, { includeDeactivated: true, includeTakenDown: true })
        if (!account || account.takedownRef) throw new AuthRequiredError('Account taken down', 'AccountTakedown')
        if (account.deactivatedAt) throw new InvalidRequestError('Account is deactivated', 'AccountDeactivated')

        const swapCommitCid = swapCommit ? CID.parse(swapCommit) : undefined
        let write
        try {
          write = await prepareCreate({ did, collection, record, rkey, validate: validate !== false })
        } catch (err) {
          if (err instanceof InvalidRecordError) throw new InvalidRequestError(err.message)
          throw err
        }

        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        const commit = await ctx.actorStore.transact(did, signingKey, async (txn) => {
          const conflicts = txn.record.getBacklinkConflicts(write.uri, write.record)
          const deletions = conflicts.map((u) => prepareDelete({ did: u.hostname, collection: u.collection, rkey: u.rkey }))
          const writes = [...deletions, write]
          return txn.processWrites(writes, swapCommitCid).catch((err) => {
            if (err instanceof BadCommitSwapError) throw new InvalidRequestError(err.message, 'InvalidSwap')
            throw err
          })
        })

        await ctx.sequencer.sequenceCommit(did, commit)
        ctx.accountManager.updateRepoRoot(did, commit.cid.toString(), commit.rev)
        void ctx.crawlers.notifyOfUpdate()

        res.json({
          uri: write.uri.toString(),
          cid: write.cid.toString(),
          commit: { cid: commit.cid.toString(), rev: commit.rev },
          validationStatus: write.validationStatus,
        })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── putRecord ──────────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.putRecord',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { repo, collection, rkey, record, validate, swapCommit, swapRecord } = req.body ?? {}

        if (!repo || !collection || !rkey || !record) {
          throw new InvalidRequestError('repo, collection, rkey, and record are required')
        }
        const repoDid = await resolveRepoToDid(ctx, repo)
        if (repoDid !== did) throw new AuthRequiredError()

        const swapCommitCid = swapCommit ? CID.parse(swapCommit) : undefined
        const swapRecordCid = swapRecord ? CID.parse(swapRecord) : undefined

        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        const { commit, write } = await ctx.actorStore.transact(did, signingKey, async (txn) => {
          const uri = AtUri.make(did, collection, rkey)
          const current = txn.record.getRecord(uri, null, true)
          const isUpdate = current !== null

          let w
          try {
            w = isUpdate
              ? await prepareUpdate({ did, collection, rkey, record, swapCid: swapRecordCid, validate: validate !== false })
              : await prepareCreate({ did, collection, rkey, record, swapCid: swapRecordCid, validate: validate !== false })
          } catch (err) {
            if (err instanceof InvalidRecordError) throw new InvalidRequestError(err.message)
            throw err
          }

          // no-op if content identical
          if (current && current.cid === w.cid.toString()) return { commit: null, write: w }

          const c = await txn.processWrites([w], swapCommitCid).catch((err) => {
            if (err instanceof BadCommitSwapError || err instanceof BadRecordSwapError) {
              throw new InvalidRequestError(err.message, 'InvalidSwap')
            }
            throw err
          })
          return { commit: c, write: w }
        })

        if (commit) {
          await ctx.sequencer.sequenceCommit(did, commit)
          ctx.accountManager.updateRepoRoot(did, commit.cid.toString(), commit.rev)
        }

        res.json({
          uri: write.uri.toString(),
          cid: write.cid.toString(),
          commit: commit ? { cid: commit.cid.toString(), rev: commit.rev } : undefined,
          validationStatus: write.validationStatus,
        })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── deleteRecord ──────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.deleteRecord',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { repo, collection, rkey, swapCommit, swapRecord } = req.body ?? {}

        if (!repo || !collection || !rkey) throw new InvalidRequestError('repo, collection, and rkey are required')
        const repoDid = await resolveRepoToDid(ctx, repo)
        if (repoDid !== did) throw new AuthRequiredError()

        const swapCommitCid = swapCommit ? CID.parse(swapCommit) : undefined
        const swapRecordCid = swapRecord ? CID.parse(swapRecord) : undefined
        const write = prepareDelete({ did, collection, rkey, swapCid: swapRecordCid })

        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        const commit = await ctx.actorStore.transact(did, signingKey, async (txn) => {
          const existing = txn.record.getRecord(write.uri, null, true)
          if (!existing) return null
          return txn.processWrites([write], swapCommitCid).catch((err) => {
            if (err instanceof BadCommitSwapError || err instanceof BadRecordSwapError) {
              throw new InvalidRequestError(err.message, 'InvalidSwap')
            }
            throw err
          })
        })

        if (commit) {
          await ctx.sequencer.sequenceCommit(did, commit)
          ctx.accountManager.updateRepoRoot(did, commit.cid.toString(), commit.rev)
        }

        res.json({ commit: commit ? { cid: commit.cid.toString(), rev: commit.rev } : undefined })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── applyWrites ───────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.applyWrites',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { repo, validate, swapCommit, writes } = req.body ?? {}

        if (!repo || !Array.isArray(writes)) throw new InvalidRequestError('repo and writes are required')
        const repoDid = await resolveRepoToDid(ctx, repo)
        if (repoDid !== did) throw new AuthRequiredError()
        if (writes.length > 200) throw new InvalidRequestError('Too many writes. Max: 200')

        const swapCommitCid = swapCommit ? CID.parse(swapCommit) : undefined

        let preparedWrites
        try {
          preparedWrites = await Promise.all(writes.map(async (w: any) => {
            if (w.$type?.endsWith('#create') || w.action === 'create') {
              return prepareCreate({ did, collection: w.collection, record: w.value, rkey: w.rkey, validate: validate !== false })
            } else if (w.$type?.endsWith('#update') || w.action === 'update') {
              return prepareUpdate({ did, collection: w.collection, record: w.value, rkey: w.rkey, validate: validate !== false })
            } else if (w.$type?.endsWith('#delete') || w.action === 'delete') {
              return prepareDelete({ did, collection: w.collection, rkey: w.rkey })
            } else {
              throw new InvalidRequestError(`Unsupported write action: ${w.$type ?? w.action}`)
            }
          }))
        } catch (err) {
          if (err instanceof InvalidRecordError) throw new InvalidRequestError(err.message)
          throw err
        }

        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        const commit = await ctx.actorStore.transact(did, signingKey, (txn) =>
          txn.processWrites(preparedWrites!, swapCommitCid).catch((err) => {
            if (err instanceof BadCommitSwapError) throw new InvalidRequestError(err.message, 'InvalidSwap')
            throw err
          }),
        )

        await ctx.sequencer.sequenceCommit(did, commit)
        ctx.accountManager.updateRepoRoot(did, commit.cid.toString(), commit.rev)

        res.json({
          commit: { cid: commit.cid.toString(), rev: commit.rev },
          results: preparedWrites.map((w) => {
            if (w.action === WriteOpAction.Create) {
              return { $type: 'com.atproto.repo.applyWrites#createResult', uri: (w as any).uri.toString(), cid: (w as any).cid.toString(), validationStatus: (w as any).validationStatus }
            } else if (w.action === WriteOpAction.Update) {
              return { $type: 'com.atproto.repo.applyWrites#updateResult', uri: (w as any).uri.toString(), cid: (w as any).cid.toString(), validationStatus: (w as any).validationStatus }
            } else {
              return { $type: 'com.atproto.repo.applyWrites#deleteResult' }
            }
          }),
        })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── uploadBlob ────────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.uploadBlob',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const encoding = req.headers['content-type'] ?? 'application/octet-stream'
        const meta = await ctx.actorStore.blob.uploadBlobAndGetMetadata(encoding, req)
        const blobRef = ctx.actorStore.blob.trackUntetheredBlob(did, meta)
        res.json({ blob: blobRef })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── listMissingBlobs ──────────────────────────────────────────────────────
  router.get('/xrpc/com.atproto.repo.listMissingBlobs',
    ctx.authVerifier.accessToken,
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const limit = Math.min(parseInt((req.query.limit as string) ?? '500', 10), 1000)
        const cursor = req.query.cursor as string | undefined
        const reader = ctx.actorStore.reader(did)
        const blobs = reader.blob.listMissingBlobs({ did, cursor, limit })
        res.json({ blobs, cursor: blobs.at(-1)?.cid })
      } catch (err) { xErr(res, err) }
    },
  )

  // ── importRepo ────────────────────────────────────────────────────────────
  router.post('/xrpc/com.atproto.repo.importRepo',
    (req, res, next) => ctx.authVerifier.accessToken(req, res, next, { checkTakedown: true }),
    async (req, res) => {
      try {
        const did = res.locals.auth.credentials.did
        const { TID } = await import('@atproto/common')
        const { readCarStream, verifyDiff, getAndParseRecord, WriteOpAction: WOA } = await import('@atproto/repo')
        const { BlobRef } = await import('@atproto/lexicon')

        const { roots, blocks: blockIter } = await readCarStream(req)
        if (roots.length !== 1) throw new InvalidRequestError('expected one root')
        const { BlockMap: BM } = await import('@atproto/repo')
        const blockMap = new BM()
        for await (const block of blockIter) blockMap.set(block.cid, block.bytes)

        const signingKey = await ctx.keyStore.getOrCreateKeypair(did)
        await ctx.actorStore.transact(did, signingKey, async (txn) => {
          const now = new Date().toISOString()
          const rev = TID.nextStr()
          const currRepo = await txn.maybeLoadRepo()
          const diff = await verifyDiff(currRepo, blockMap, roots[0], undefined, undefined, { ensureLeaves: false })
          diff.commit.rev = rev
          await txn.storage.applyCommit(diff.commit, currRepo === null)
          for (const write of diff.writes) {
            const uri = AtUri.make(did, write.collection, write.rkey)
            if (write.action === WOA.Delete) {
              txn.record.deleteRecord(uri)
            } else {
              const parsed = await getAndParseRecord(blockMap, write.cid)
              txn.record.indexRecord(uri, write.cid, parsed.record, write.action as any, rev, now)
              const blobs = findBlobRefs(parsed.record)
              txn.blob.insertBlobs(did, uri.toString(), blobs as any)
            }
          }
        })

        res.status(200).end()
      } catch (err) { xErr(res, err) }
    },
  )
}

function extractHandle(didDoc: Record<string, unknown>): string | null {
  const aka = (didDoc as any).alsoKnownAs
  if (!Array.isArray(aka)) return null
  const u = (aka as string[]).find((s) => s.startsWith('at://'))
  return u ? u.slice(5) : null
}

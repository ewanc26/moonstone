import { z } from 'zod'
import { cborEncode, cborDecode, schema } from '@atproto/common'
import { BlockMap, blocksToCarFile } from '@atproto/repo'
import type { CommitDataWithOps, SyncEvtData } from '../repo/types.js'
import { AccountStatus } from '../account-manager/index.js'

// ---------------------------------------------------------------------------
// DB types
// ---------------------------------------------------------------------------

export type RepoSeqInsert = {
  did: string
  eventType: 'append' | 'sync' | 'identity' | 'account'
  event: Uint8Array
  sequencedAt: string
}

export type RepoSeqRow = {
  seq: number
  did: string
  eventType: string
  event: Buffer
  invalidated: number
  sequencedAt: string
}

// ---------------------------------------------------------------------------
// Event zod schemas (mirrors blacksky)
// ---------------------------------------------------------------------------

export const commitEvt = z.object({
  rebase: z.boolean(),
  tooBig: z.boolean(),
  repo: z.string(),
  commit: schema.cid,
  rev: z.string(),
  since: z.string().nullable(),
  blocks: schema.bytes,
  ops: z.array(z.object({
    action: z.union([z.literal('create'), z.literal('update'), z.literal('delete')]),
    path: z.string(),
    cid: schema.cid.nullable(),
    prev: schema.cid.optional(),
  })),
  blobs: z.array(schema.cid),
  prevData: schema.cid.optional(),
})
export type CommitEvt = z.infer<typeof commitEvt>

export const syncEvt = z.object({ did: z.string(), blocks: schema.bytes, rev: z.string() })
export type SyncEvt = z.infer<typeof syncEvt>

export const identityEvt = z.object({ did: z.string(), handle: z.string().optional() })
export type IdentityEvt = z.infer<typeof identityEvt>

export const accountEvt = z.object({
  did: z.string(),
  active: z.boolean(),
  status: z.enum([
    AccountStatus.Takendown, AccountStatus.Suspended, AccountStatus.Deleted, AccountStatus.Deactivated,
  ]).optional(),
})
export type AccountEvt = z.infer<typeof accountEvt>

export type SeqEvt =
  | { type: 'commit';   seq: number; time: string; evt: CommitEvt }
  | { type: 'sync';     seq: number; time: string; evt: SyncEvt }
  | { type: 'identity'; seq: number; time: string; evt: IdentityEvt }
  | { type: 'account';  seq: number; time: string; evt: AccountEvt }

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export async function formatSeqCommit(did: string, data: CommitDataWithOps): Promise<RepoSeqInsert> {
  const blocksToSend = new BlockMap()
  blocksToSend.addMap(data.newBlocks)
  blocksToSend.addMap(data.relevantBlocks)
  const evt = {
    repo: did,
    commit: data.cid,
    rev: data.rev,
    since: data.since ?? null,
    blocks: await blocksToCarFile(data.cid, blocksToSend),
    ops: data.ops,
    prevData: data.prevData ?? undefined,
    rebase: false,
    tooBig: false,
    blobs: [],
  }
  return { did, eventType: 'append', event: cborEncode(evt), sequencedAt: new Date().toISOString() }
}

export async function formatSeqSyncEvt(did: string, data: SyncEvtData): Promise<RepoSeqInsert> {
  const blocks = await blocksToCarFile(data.cid, data.blocks)
  return { did, eventType: 'sync', event: cborEncode({ did, rev: data.rev, blocks }), sequencedAt: new Date().toISOString() }
}

export async function formatSeqIdentityEvt(did: string, handle?: string): Promise<RepoSeqInsert> {
  const evt: IdentityEvt = { did, ...(handle ? { handle } : {}) }
  return { did, eventType: 'identity', event: cborEncode(evt), sequencedAt: new Date().toISOString() }
}

export async function formatSeqAccountEvt(did: string, status: AccountStatus): Promise<RepoSeqInsert> {
  const evt: AccountEvt = { did, active: status === AccountStatus.Active, ...(status !== AccountStatus.Active ? { status } : {}) }
  return { did, eventType: 'account', event: cborEncode(evt), sequencedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Parse raw DB rows → SeqEvt[]
// ---------------------------------------------------------------------------

export function parseSeqRows(rows: RepoSeqRow[]): SeqEvt[] {
  const out: SeqEvt[] = []
  for (const row of rows) {
    if (row.seq === null) continue
    const evt = cborDecode(row.event)
    if (row.eventType === 'append') {
      out.push({ type: 'commit', seq: row.seq, time: row.sequencedAt, evt: evt as CommitEvt })
    } else if (row.eventType === 'sync') {
      out.push({ type: 'sync', seq: row.seq, time: row.sequencedAt, evt: evt as SyncEvt })
    } else if (row.eventType === 'identity') {
      out.push({ type: 'identity', seq: row.seq, time: row.sequencedAt, evt: evt as IdentityEvt })
    } else if (row.eventType === 'account') {
      out.push({ type: 'account', seq: row.seq, time: row.sequencedAt, evt: evt as AccountEvt })
    }
  }
  return out
}

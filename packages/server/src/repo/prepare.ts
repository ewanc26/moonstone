import { CID } from 'multiformats/cid'
import { TID, dataToCborBlock } from '@atproto/common'
import { BlobRef, LexValue, RepoRecord, lexToIpld } from '@atproto/lexicon'
import {
  RecordCreateOp, RecordDeleteOp, RecordUpdateOp, RecordWriteOp,
  WriteOpAction, cborToLex,
} from '@atproto/repo'
import { AtUri, ensureValidRecordKey } from '@atproto/syntax'
import {
  InvalidRecordError, PreparedBlobRef, PreparedCreate, PreparedDelete,
  PreparedUpdate, PreparedWrite, ValidationStatus,
} from './types.js'

// ---------------------------------------------------------------------------
// prepare helpers
// ---------------------------------------------------------------------------

export const prepareCreate = async (opts: {
  did: string
  collection: string
  rkey?: string
  swapCid?: CID | null
  record: RepoRecord
  validate?: boolean
}): Promise<PreparedCreate> => {
  const { did, collection, swapCid, validate } = opts
  const record = ensureType(collection, opts.record, validate !== false)
  const validationStatus: ValidationStatus = validate !== false ? 'valid' : undefined
  const rkey = opts.rkey ?? TID.next().toString()
  ensureValidRecordKey(rkey)
  return {
    action: WriteOpAction.Create,
    uri: AtUri.make(did, collection, rkey),
    cid: await cidForRecord(record),
    swapCid,
    record,
    blobs: findBlobRefs(record).map(blobRefToPrepared),
    validationStatus,
  }
}

export const prepareUpdate = async (opts: {
  did: string
  collection: string
  rkey: string
  swapCid?: CID | null
  record: RepoRecord
  validate?: boolean
}): Promise<PreparedUpdate> => {
  const { did, collection, rkey, swapCid, validate } = opts
  const record = ensureType(collection, opts.record, validate !== false)
  const validationStatus: ValidationStatus = validate !== false ? 'valid' : undefined
  return {
    action: WriteOpAction.Update,
    uri: AtUri.make(did, collection, rkey),
    cid: await cidForRecord(record),
    swapCid,
    record,
    blobs: findBlobRefs(record).map(blobRefToPrepared),
    validationStatus,
  }
}

export const prepareDelete = (opts: {
  did: string
  collection: string
  rkey: string
  swapCid?: CID | null
}): PreparedDelete => ({
  action: WriteOpAction.Delete,
  uri: AtUri.make(opts.did, opts.collection, opts.rkey),
  swapCid: opts.swapCid,
})

// ---------------------------------------------------------------------------
// write op adapters for @atproto/repo
// ---------------------------------------------------------------------------

export const createWriteToOp = (w: PreparedCreate): RecordCreateOp => ({
  action: WriteOpAction.Create,
  collection: w.uri.collection,
  rkey: w.uri.rkey,
  record: w.record,
})

export const updateWriteToOp = (w: PreparedUpdate): RecordUpdateOp => ({
  action: WriteOpAction.Update,
  collection: w.uri.collection,
  rkey: w.uri.rkey,
  record: w.record,
})

export const deleteWriteToOp = (w: PreparedDelete): RecordDeleteOp => ({
  action: WriteOpAction.Delete,
  collection: w.uri.collection,
  rkey: w.uri.rkey,
})

export const writeToOp = (w: PreparedWrite): RecordWriteOp => {
  switch (w.action) {
    case WriteOpAction.Create: return createWriteToOp(w)
    case WriteOpAction.Update: return updateWriteToOp(w)
    case WriteOpAction.Delete: return deleteWriteToOp(w)
    default: throw new Error(`Unrecognized action: ${(w as any).action}`)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureType(collection: string, record: RepoRecord, validate: boolean): RepoRecord {
  if (!record.$type) record.$type = collection
  if (validate && record.$type !== collection) {
    throw new InvalidRecordError(`Invalid $type: expected ${collection}, got ${record.$type}`)
  }
  return record
}

async function cidForRecord(record: RepoRecord): Promise<CID> {
  try {
    const block = await dataToCborBlock(lexToIpld(record))
    cborToLex(block.bytes) // round-trip check
    return block.cid
  } catch (err) {
    const e = new InvalidRecordError('Bad record')
    e.cause = err
    throw e
  }
}

function blobRefToPrepared(ref: BlobRef): PreparedBlobRef {
  return { size: ref.size, cid: ref.ref, mimeType: ref.mimeType, constraints: {} }
}

export function findBlobRefs(val: LexValue, layer = 0): BlobRef[] {
  if (layer > 32) return []
  if (Array.isArray(val)) return val.flatMap((v) => findBlobRefs(v, layer + 1))
  if (val && typeof val === 'object') {
    if (val instanceof BlobRef) return [val]
    if (CID.asCID(val) || val instanceof Uint8Array) return []
    return Object.values(val).flatMap((v) => findBlobRefs(v as LexValue, layer + 1))
  }
  return []
}

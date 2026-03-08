import EventEmitter from 'node:events'
import { SECOND, wait, cborDecode } from '@atproto/common'
import type { Db } from '../db/index.js'
import type { CommitDataWithOps, SyncEvtData } from '../repo/types.js'
import { AccountStatus } from '../account-manager/index.js'
import { logger } from '../logger.js'
import {
  RepoSeqInsert, RepoSeqRow, SeqEvt,
  formatSeqCommit, formatSeqSyncEvt, formatSeqIdentityEvt, formatSeqAccountEvt,
  parseSeqRows,
} from './events.js'

export * from './events.js'

export class Sequencer extends EventEmitter {
  lastSeen = 0
  destroyed = false
  private _pollPromise: Promise<void> | null = null
  private _triesWithNoResults = 0

  constructor(private db: Db) {
    super()
    this.setMaxListeners(200)
  }

  start(): void {
    const curr = this.curr()
    this.lastSeen = curr ?? 0
    if (this._pollPromise === null) {
      this._pollPromise = this._poll()
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    if (this._pollPromise) await this._pollPromise
    this.emit('close')
  }

  curr(): number | null {
    const row = this.db
      .prepare(`SELECT seq FROM repo_seq ORDER BY seq DESC LIMIT 1`)
      .get() as { seq: number } | undefined
    return row?.seq ?? null
  }

  next(cursor: number): RepoSeqRow | null {
    return (this.db
      .prepare(`SELECT * FROM repo_seq WHERE seq > ? ORDER BY seq ASC LIMIT 1`)
      .get(cursor) as RepoSeqRow | undefined) ?? null
  }

  earliestAfterTime(time: string): RepoSeqRow | null {
    return (this.db
      .prepare(`SELECT * FROM repo_seq WHERE sequencedAt >= ? ORDER BY sequencedAt ASC LIMIT 1`)
      .get(time) as RepoSeqRow | undefined) ?? null
  }

  requestSeqRange(opts: {
    earliestSeq?: number
    latestSeq?: number
    earliestTime?: string
    limit?: number
  }): SeqEvt[] {
    const { earliestSeq, latestSeq, earliestTime, limit = 500 } = opts
    let sql = `SELECT * FROM repo_seq WHERE invalidated = 0`
    const args: unknown[] = []
    if (earliestSeq !== undefined) { sql += ` AND seq > ?`; args.push(earliestSeq) }
    if (latestSeq !== undefined)   { sql += ` AND seq <= ?`; args.push(latestSeq) }
    if (earliestTime !== undefined) { sql += ` AND sequencedAt >= ?`; args.push(earliestTime) }
    sql += ` ORDER BY seq ASC LIMIT ?`
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as RepoSeqRow[]
    return parseSeqRows(rows)
  }

  private async _poll(): Promise<void> {
    if (this.destroyed) return
    try {
      const evts = this.requestSeqRange({ earliestSeq: this.lastSeen, limit: 1000 })
      if (evts.length > 0) {
        this._triesWithNoResults = 0
        this.emit('events', evts)
        this.lastSeen = evts.at(-1)!.seq
      } else {
        await this._backoff()
      }
    } catch (err) {
      logger.error({ err, lastSeen: this.lastSeen }, 'sequencer poll failed')
      await this._backoff()
    }
    this._pollPromise = this._poll()
  }

  private async _backoff(): Promise<void> {
    this._triesWithNoResults++
    await wait(Math.min(Math.pow(2, this._triesWithNoResults), SECOND))
  }

  sequenceEvt(evt: RepoSeqInsert): number {
    const result = this.db
      .prepare(`INSERT INTO repo_seq (did, eventType, event, invalidated, sequencedAt) VALUES (?, ?, ?, 0, ?) RETURNING seq`)
      .get(evt.did, evt.eventType, evt.event, evt.sequencedAt) as { seq: number }
    return result.seq
  }

  async sequenceCommit(did: string, data: CommitDataWithOps): Promise<number> {
    return this.sequenceEvt(await formatSeqCommit(did, data))
  }

  async sequenceSyncEvt(did: string, data: SyncEvtData): Promise<number> {
    return this.sequenceEvt(await formatSeqSyncEvt(did, data))
  }

  async sequenceIdentityEvt(did: string, handle?: string): Promise<number> {
    return this.sequenceEvt(await formatSeqIdentityEvt(did, handle))
  }

  async sequenceAccountEvt(did: string, status: AccountStatus): Promise<number> {
    return this.sequenceEvt(await formatSeqAccountEvt(did, status))
  }
}

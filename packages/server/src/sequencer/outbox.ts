import { InvalidRequestError } from '@atproto/xrpc-server'
import { AsyncBuffer, AsyncBufferFullError } from '@atproto/common'
import type { Sequencer, SeqEvt } from './index.js'

export class Outbox {
  private caughtUp = false
  lastSeen = -1
  cutoverBuffer: SeqEvt[] = []
  outBuffer: AsyncBuffer<SeqEvt>

  constructor(
    public sequencer: Sequencer,
    opts: { maxBufferSize?: number } = {},
  ) {
    this.outBuffer = new AsyncBuffer<SeqEvt>(opts.maxBufferSize ?? 500)
  }

  async *events(backfillCursor?: number, signal?: AbortSignal): AsyncGenerator<SeqEvt> {
    if (backfillCursor !== undefined) {
      for await (const evt of this._getBackfill(backfillCursor)) {
        if (signal?.aborted) return
        this.lastSeen = evt.seq
        yield evt
      }
    } else {
      this.caughtUp = true
    }

    const addToBuffer = (evts: SeqEvt[]) => {
      if (this.caughtUp) {
        this.outBuffer.pushMany(evts)
      } else {
        this.cutoverBuffer = [...this.cutoverBuffer, ...evts]
      }
    }

    if (!signal?.aborted) {
      this.sequencer.on('events', addToBuffer)
    }
    signal?.addEventListener('abort', () => this.sequencer.off('events', addToBuffer))

    const cutover = async () => {
      if (backfillCursor !== undefined) {
        const cutoverEvts = this.sequencer.requestSeqRange({
          earliestSeq: this.lastSeen > -1 ? this.lastSeen : backfillCursor,
        })
        this.outBuffer.pushMany(cutoverEvts)
        this.outBuffer.pushMany(this.cutoverBuffer)
        this.caughtUp = true
        this.cutoverBuffer = []
      } else {
        this.caughtUp = true
      }
    }
    cutover()

    while (true) {
      try {
        for await (const evt of this.outBuffer.events()) {
          if (signal?.aborted) return
          if (evt.seq > this.lastSeen) {
            this.lastSeen = evt.seq
            yield evt
          }
        }
      } catch (err) {
        if (err instanceof AsyncBufferFullError) {
          throw new InvalidRequestError('Stream consumer too slow', 'ConsumerTooSlow')
        }
        throw err
      }
    }
  }

  private async *_getBackfill(backfillCursor: number): AsyncGenerator<SeqEvt> {
    const PAGE_SIZE = 500
    while (true) {
      const evts = this.sequencer.requestSeqRange({
        earliestSeq: this.lastSeen > -1 ? this.lastSeen : backfillCursor,
        limit: PAGE_SIZE,
      })
      for (const evt of evts) yield evt
      const seqCursor = this.sequencer.lastSeen ?? -1
      if (seqCursor - this.lastSeen < PAGE_SIZE / 2) break
      if (evts.length < 1) break
    }
  }
}

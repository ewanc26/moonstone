/**
 * Crawler notification — fires a com.atproto.sync.requestCrawl at each
 * configured relay after a commit, rate-limited to once every 20 minutes.
 */
import { MINUTE } from '@atproto/common'
import { logger } from './logger.js'

const NOTIFY_THRESHOLD_MS = 20 * MINUTE

export class Crawlers {
  private lastNotified = 0

  constructor(
    private hostname: string,
    private crawlerUrls: string[],
  ) {}

  async notifyOfUpdate(): Promise<void> {
    const now = Date.now()
    if (now - this.lastNotified < NOTIFY_THRESHOLD_MS) return
    this.lastNotified = now
    // Fire-and-forget — don't block the commit path.
    void this._notifyAll().catch((err) => {
      logger.warn({ err }, 'crawler notification batch failed')
    })
  }

  private async _notifyAll(): Promise<void> {
    await Promise.allSettled(
      this.crawlerUrls.map((url) => this._notify(url)),
    )
  }

  private async _notify(crawlerUrl: string): Promise<void> {
    try {
      const res = await fetch(
        `${crawlerUrl}/xrpc/com.atproto.sync.requestCrawl`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hostname: this.hostname }),
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (!res.ok) {
        logger.warn({ crawlerUrl, status: res.status }, 'crawler rejected requestCrawl')
      }
    } catch (err) {
      logger.warn({ err, crawlerUrl }, 'failed to requestCrawl')
    }
  }
}

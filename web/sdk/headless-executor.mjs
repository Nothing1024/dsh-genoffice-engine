import { chromium } from 'playwright'
import { appForPath, docIdFor } from './genoffice-control.mjs'

/**
 * Per-document headless renderer manager.
 * Reuses the page for the same path; never steals a different owner.
 */
export class HeadlessExecutor {
  constructor({ client, browserFactory } = {}) {
    this.client = client
    this.browserFactory = browserFactory || (() => chromium.launch({ headless: true }))
    this.browser = null
    this.sessions = new Map()
  }

  async ensureBrowser() {
    if (this.browser) return this.browser
    try {
      this.browser = await this.browserFactory()
    } catch (err) {
      const error = new Error(`headless runtime missing: ${err instanceof Error ? err.message : String(err)}`)
      error.code = 'runtime-missing'
      throw error
    }
    return this.browser
  }

  sessionKey(path) {
    return docIdFor(path)
  }

  async open(path, { timeout = 90_000, owner = 'headless' } = {}) {
    const app = appForPath(path)
    if (!app) {
      const err = new Error(`unsupported path: ${path}`)
      err.code = 'unsupported'
      throw err
    }
    const existing = await this.client.open(path)
    const mine = this.sessions.has(this.sessionKey(path))
    if (existing.readiness === 'ready' && existing.registered) {
      if (mine) return { ...existing, reused: true, spawned: false, retained: false }
      const err = new Error('occupied')
      err.code = 'occupied'
      err.last = existing
      throw err
    }
    if (existing.occupied && existing.owner && existing.owner !== owner && mine === false) {
      const err = new Error('occupied')
      err.code = 'occupied'
      err.last = existing
      throw err
    }
    const key = this.sessionKey(path)
    let session = this.sessions.get(key)
    if (!session) {
      const browser = await this.ensureBrowser()
      const page = await browser.newPage()
      session = { page, path, app, owner, dirty: false }
      this.sessions.set(key, session)
      const url = `${this.client.base}/${app}/?control=1&open=${encodeURIComponent(`path:${path}`)}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
    }
    const ready = await this.client.waitReady(path, { timeout })
    if (ready.readiness !== 'ready') {
      await this.release(path, { force: true })
      const err = new Error(ready.error || ready.readiness || 'headless open failed')
      err.code = 'spawn-failed'
      err.last = ready
      throw err
    }
    return { ...ready, reused: Boolean(existing.registered), spawned: true }
  }

  async release(path, { force = false, dirty = false } = {}) {
    const key = this.sessionKey(path)
    const session = this.sessions.get(key)
    if (!session) return { released: false, retained: false }
    if (dirty && force === false) {
      session.dirty = true
      return { released: false, retained: true, reason: 'dirty' }
    }
    await session.page.close().catch(() => {})
    this.sessions.delete(key)
    return { released: true, retained: false }
  }

  async close({ force = false } = {}) {
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.dirty && force === false) continue
      await session.page.close().catch(() => {})
      this.sessions.delete(key)
    }
    if (this.sessions.size === 0 && this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }
}

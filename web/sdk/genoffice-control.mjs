import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'

export const PROTOCOL = 'genoffice-control'
export const PROTOCOL_VERSION = '1.0.0'
export const SCHEMA_REVISION = '2026.09.1'

export const APP_BY_EXT = {
  '.docx': 'docs',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.xlsx': 'sheets',
  '.pptx': 'slides',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
}

export function docIdFor(absPath) {
  return createHash('sha256').update(String(absPath)).digest('hex')
}

export function appForPath(filePath) {
  return APP_BY_EXT[extname(filePath).toLowerCase()] || null
}

export class GenOfficeClient {
  constructor({
    base = 'http://127.0.0.1:8787',
    family = null,
    schemaRevision = SCHEMA_REVISION,
    protocol = PROTOCOL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.base = String(base).replace(/\/$/, '')
    this.family = family
    this.schemaRevision = schemaRevision
    this.protocol = protocol
    this.fetchImpl = fetchImpl
  }

  headers(extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra }
    if (this.schemaRevision) headers['X-GenOffice-Schema-Revision'] = this.schemaRevision
    if (this.family) headers['X-GenOffice-Family'] = this.family
    if (this.protocol) headers['X-GenOffice-Protocol'] = this.protocol
    return headers
  }

  async request(method, url, { body, headers, signal } = {}) {
    const resp = await this.fetchImpl(this.base + url, {
      method,
      headers: this.headers(headers),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const raw = await resp.text()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { ok: false, error: `non-json ${resp.status}: ${raw.slice(0, 200)}` }
    }
    return { ...parsed, status: resp.status }
  }

  discover(query = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') params.set(key, String(value))
    }
    const suffix = params.toString() ? `?${params}` : ''
    return this.request('GET', `/api/discovery${suffix}`)
  }

  health() {
    return this.request('GET', '/api/health')
  }

  open(path, extra = {}) {
    return this.request('POST', '/api/control/open', { body: { path, ...extra } })
  }

  async waitReady(path, { timeout = 90_000, interval = 200, signal } = {}) {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        const err = new Error('aborted')
        err.code = 'aborted'
        throw err
      }
      last = await this.open(path)
      if (last.readiness === 'ready' || last.readiness === 'error') return last
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    const err = new Error(`waitReady timeout: ${last?.readiness ?? last?.error ?? 'unknown'}`)
    err.code = 'timeout'
    err.last = last
    throw err
  }

  context(app, path) {
    return this.request('POST', `/api/control/${app}/${docIdFor(path)}/context`, { body: {} })
  }

  tool(app, path, name, input = {}, extra = {}) {
    return this.request('POST', `/api/control/${app}/${docIdFor(path)}/tool`, {
      body: { call: { id: randomUUID(), name, input } },
      signal: extra.signal,
    })
  }

  save(app, path, extra = {}) {
    return this.request('POST', `/api/control/${app}/${docIdFor(path)}/export`, {
      body: { path, ...extra },
      signal: extra.signal,
    })
  }
}

export function toolOk(result) {
  return result?.ok === true && result?.execution?.isError !== true
}

export function toolOutput(result) {
  return String(result?.execution?.output ?? result?.output ?? result?.execution?.error ?? result?.error ?? result?.context ?? '')
}

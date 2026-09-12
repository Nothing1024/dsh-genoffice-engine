/**
 * Control-mode adapter for the GenOffice HTML renderer.
 * Registers the iframe executor with the relay and serves tool/context/export.
 */
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import { createHtmlSkillCore, type HtmlDocAccess } from './ai/tools'
import { buildParseMap } from './document/parse-map'

const params = new URLSearchParams(location.search)

export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

export const CONTROL_PATH: string | null = openTarget.startsWith('path:')
  ? openTarget.slice('path:'.length)
  : null


export type FileLoadMeta = {
  mtimeMs?: number | null
  fileRevision?: string | null
}

type FileMetaSink = { apply(meta: FileLoadMeta): void }

let pendingLoadMeta: FileLoadMeta | null = null
let liveFileMetaSink: FileMetaSink | null = null

/** Bind byte-bound mtime/revision from the same GET /api/file that loaded the document. */
export function bindLoadMeta(meta: FileLoadMeta): void {
  pendingLoadMeta = meta
  liveFileMetaSink?.apply(meta)
}

function applyPendingFileMeta(
  setMtime: (value: number) => void,
  setRev: (value: string) => void,
): void {
  const sink: FileMetaSink = {
    apply(meta) {
      if (typeof meta.mtimeMs === "number") setMtime(meta.mtimeMs)
      if (typeof meta.fileRevision === "string" && meta.fileRevision) setRev(meta.fileRevision)
    },
  }
  liveFileMetaSink = sink
  if (pendingLoadMeta) sink.apply(pendingLoadMeta)
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function ownerIdFor(path: string): string {
  const key = `genoffice-control-owner:${path}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

async function notify(
  docId: string,
  kind: 'tool-result' | 'context' | 'export' | 'status',
  requestId: string | undefined,
  payload: unknown,
  owner?: string,
): Promise<void> {
  try {
    await fetch('/api/control/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, kind, requestId, payload, owner }),
    })
  } catch (e) {
    console.error('[control] notify failed:', e)
  }
}

function errorExecution(output: string, summary: string): ToolExecution {
  return { output, isError: true, summary }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

const EMPTY_MAP = buildParseMap('', 0)

export interface ControlAdapterOptions {
  getAccess: () => HtmlDocAccess | null
  exportBytes: () => Promise<{ bytes: Uint8Array; name: string } | null>
  getDirty?: () => boolean
  onSaved?: () => void
}

export interface ControlHandle {
  close: () => void
  setReadiness: (readiness: 'loading' | 'ready' | 'error', extra?: { revision?: string; error?: string }) => void
  bumpRevision: () => void
}

export function initControlMode(opts: ControlAdapterOptions): ControlHandle | null {
  if (!CONTROL_MODE) return null
  if (!CONTROL_PATH) {
    console.warn('[control] control=1 without a path: open target — executor not registered')
    return null
  }

  const ownerId = ownerIdFor(CONTROL_PATH)
  const docIdPromise = sha256Hex(CONTROL_PATH)
  let es: EventSource | null = null
  let closed = false
  let occupied = false
  let readiness: 'loading' | 'ready' | 'error' = 'loading'
  let revision: string | null = null
  let loadError: string | null = null
  const core = createHtmlSkillCore({
    getText: () => opts.getAccess()?.getText() ?? '',
    getVersion: () => opts.getAccess()?.getVersion() ?? 0,
    getMap: () => opts.getAccess()?.getMap() ?? EMPTY_MAP,
    getLastManualVersion: () => opts.getAccess()?.getLastManualVersion() ?? 0,
    getFilePath: () => opts.getAccess()?.getFilePath() ?? CONTROL_PATH,
    getSelectedSid: () => opts.getAccess()?.getSelectedSid() ?? null,
    applyOps: (ops, label) => {
      const access = opts.getAccess()
      if (!access) return { ok: false, errors: [{ index: 0, kind: 'bad_args', message: 'editor not ready' }] }
      return access.applyOps(ops, label)
    },
    replaceAll: (html, label) => {
      opts.getAccess()?.replaceAll(html, label)
    },
  })
  const flushStatus = (): void => {
    void docIdPromise.then((docId) => {
      if (closed || occupied) return
      void notify(docId, 'status', undefined, { readiness, revision, error: loadError }, ownerId)
    })
  }
  const setReadiness = (
    next: 'loading' | 'ready' | 'error',
    extra?: { revision?: string; error?: string },
  ): void => {
    readiness = next
    if (extra?.revision !== undefined) revision = extra.revision
    loadError = next === 'error' ? extra?.error ?? loadError : extra?.error ?? null
    flushStatus()
  }
  const bumpRevision = (): void => {
    void (async () => {
      const access = opts.getAccess()
      if (!access || closed || occupied) return
      revision = await sha256Hex(access.getText())
      flushStatus()
    })()
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let dirtyTimer: ReturnType<typeof setInterval> | null = null
  let lastDirty: boolean | undefined
  const reportDirty = (id: string, dirty: boolean): void => {
    lastDirty = dirty
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'genoffice:dirty', docId: id, dirty }, '*')
    }
  }
  const openStream = async (): Promise<void> => {
    const docId = await docIdPromise
    if (closed || occupied) return
    es?.close()
    es = new EventSource(`/api/control/stream?docId=${docId}&owner=${encodeURIComponent(ownerId)}`)
    es.onopen = () => console.log(`[html] [control] stream open (docId=${docId.slice(0, 8)}…)`)
    es.addEventListener('hello', () => {
      console.log(`[html] [control] executor registered (${CONTROL_PATH})`)
      flushStatus()
    })
    es.addEventListener('occupied', () => {
      occupied = true
      console.warn('[control] occupied — this window is not the executor')
      es?.close()
    })
    es.addEventListener('tool', (ev) => {
      void handleTool(docId, ev as MessageEvent)
    })
    es.addEventListener('context', (ev) => {
      void handleContext(docId, ev as MessageEvent)
    })
    es.addEventListener('export', (ev) => {
      void handleExport(docId, ev as MessageEvent)
    })
    es.addEventListener('saved', (ev) => {
      let data: {
        mtimeMs?: unknown
        exportRevision?: unknown
        fileRevision?: unknown
      } = {}
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }
      if (typeof data.mtimeMs === 'number') mtimeMs = data.mtimeMs
      if (typeof data.fileRevision === 'string') fileRev = data.fileRevision
      if (data.exportRevision != null && String(data.exportRevision) !== String(revision)) {
        return
      }
      opts.onSaved?.()
      reportDirty(docId, false)
    })
    es.onerror = () => {
      if (closed || occupied) {
        es?.close()
        return
      }
      console.warn('[control] stream error — reconnecting…')
      es?.close()
      if (document.visibilityState === 'visible') {
        reconnectTimer = setTimeout(() => {
          void openStream()
        }, 1000)
      }
    }
  }

  const handleTool = async (docId: string, ev: MessageEvent): Promise<void> => {
    let data: { requestId?: string; call?: AgentToolCall } = {}
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    const requestId = data.requestId
    const call = data.call
    if (!call || typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
      await notify(docId, 'tool-result', requestId, errorExecution('invalid input', call?.name ?? 'unknown'), ownerId)
      return
    }
    const expected = (call.input as { expectedRevision?: unknown }).expectedRevision
    if (typeof expected === 'string' && expected !== '' && expected !== revision) {
      await notify(
        docId,
        'tool-result',
        requestId,
        {
          ...errorExecution('conflict: stale revision; re-read context then retry', call.name),
          error: 'conflict',
          revision,
        },
        ownerId,
      )
      return
    }
    if (readiness !== 'ready' || !opts.getAccess()) {
      await notify(docId, 'tool-result', requestId, errorExecution('editor not ready', call.name), ownerId)
      return
    }
    try {
      const execution = await Promise.resolve(core.executeTool(call))
      if (!execution.isError) {
        const next = await sha256Hex(opts.getAccess()?.getText() ?? '')
        if (next !== revision) {
          revision = next
          await notify(docId, 'status', undefined, { readiness, revision, error: loadError }, ownerId)
        }
      }
      await notify(docId, 'tool-result', requestId, { ...execution, revision }, ownerId)
    } catch (e) {
      await notify(
        docId,
        'tool-result',
        requestId,
        errorExecution(`tool execution failed: ${e instanceof Error ? e.message : String(e)}`, call.name),
        ownerId,
      )
    }
  }

  const handleContext = async (docId: string, ev: MessageEvent): Promise<void> => {
    let requestId: string | undefined
    try {
      requestId = (JSON.parse(ev.data) as { requestId?: string }).requestId
    } catch {
      return
    }
    if (readiness !== 'ready' || !opts.getAccess()) {
      await notify(docId, 'context', requestId, { context: 'editor not ready', revision }, ownerId)
      return
    }
    await notify(docId, 'context', requestId, { context: core.buildContext(), revision }, ownerId)
  }

  const handleExport = async (docId: string, ev: MessageEvent): Promise<void> => {
    let requestId: string | undefined
    try {
      requestId = (JSON.parse(ev.data) as { requestId?: string }).requestId
    } catch {
      return
    }
    const exportRevision = revision
    try {
      const exported = await opts.exportBytes()
      if (!exported) {
        await notify(docId, 'export', requestId, { error: 'export failed: no document loaded' }, ownerId)
        return
      }
      const base64 = bytesToBase64(exported.bytes)
      const mtime = await captureMtime()
      await notify(
        docId,
        'export',
        requestId,
        {
          base64,
          name: exported.name,
          path: CONTROL_PATH,
          mtimeMs: mtime,
          expectedRevision: fileRev,
          exportRevision,
          owner: ownerId,
        },
        ownerId,
      )
    } catch (e) {
      await notify(
        docId,
        'export',
        requestId,
        {
          error: `export failed: ${e instanceof Error ? e.message : String(e)}`,
        },
        ownerId,
      )
    }
  }

  let mtimeMs: number | null = null
  let fileRev: string | null = null
  const captureMtime = async (): Promise<number | null> => mtimeMs
  applyPendingFileMeta(
    (value) => { mtimeMs = value },
    (value) => { fileRev = value },
  )

  if (opts.getDirty) {
    void (async () => {
      const id = await docIdPromise
      if (closed) return
      const tick = (): void => {
        const dirty = Boolean(opts.getDirty?.())
        if (dirty === lastDirty) return
        reportDirty(id, dirty)
      }
      tick()
      dirtyTimer = setInterval(tick, 1000)
    })()
  }

  const onVisibility = (): void => {
    if (occupied) return
    if (document.visibilityState === 'visible' && (es === null || es.readyState === EventSource.CLOSED)) {
      void openStream()
    }
  }
  const onOnline = (): void => {
    if (occupied) return
    if (es === null || es.readyState === EventSource.CLOSED) void openStream()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)

  const close = (): void => {
    closed = true
    liveFileMetaSink = null
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    if (dirtyTimer !== null) clearInterval(dirtyTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    es?.close()
    es = null
  }
  window.addEventListener('pagehide', close)

  const url = new URL(location.href)
  if (url.searchParams.has('control')) {
    url.searchParams.delete('control')
    history.replaceState(null, '', url)
  }

  void openStream()
  return { close, setReadiness, bumpRevision }
}

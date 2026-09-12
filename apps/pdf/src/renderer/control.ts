/**
 * Control-mode adapter for the GenOffice PDF renderer (genoffice-dsh-office).
 *
 * INV-004 mirror: contracts/control-api.md §2.1 saved + §2.8 dirty — same contract as the other app
 * adapters (SSE downstream + POST notify upstream, docId = sha256(absolute
 * path)). Active only with `control=1` + a `path:` open target (BR-001);
 * non-control loads take zero side effects (INV-001). All edits go through
 * the renderer state (pdf-skill deps over PdfAiDeps — INV-005), never direct
 * file writes.
 */
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import type { SavePdfRequest } from '../shared/ipc'
import type { PdfAiDeps } from './ai/tools'
import { executePdfTool } from './ai/tools'

// ── module-level capture ──────────────────────────────────────────────
const params = new URLSearchParams(location.search)

/** BR-001: control mode active. Shared with App.tsx for the AI-dock hiding rule. */
export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

/** Original absolute path from the `path:` open target (BR-009 docId source). */
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

let activeOwner: string | undefined

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
      body: JSON.stringify({ docId, kind, requestId, payload, owner: owner ?? activeOwner }),
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

export type ControlExportBytes = () => Promise<{ bytes: Uint8Array; name: string } | null>

declare global {
  interface Window {
    __genofficeExportBytes?: () => Promise<{ bytes: Uint8Array; name: string } | null>
  }
}

export interface ControlAdapterOptions {
  /** fresh skill deps accessor (the App's PdfAiDeps closure; never stale) */
  getDeps: () => PdfAiDeps | null
  /** build the CURRENT save request from the renderer's pending edits (BR-008) */
  getSaveRequest: () => SavePdfRequest | null
  /** serialize CURRENT merged bytes (web-bridge exportPdfBytes; injected so desktop never imports it) */
  exportBytes: ControlExportBytes
  /** persisted-content dirty (desktop close-guard same signal); optional for INV-003 old callers */
  getDirty?: () => boolean
  /** clear the editor dirty source after a successful write-back (BR-004) */
  onSaved?: () => void
  /**
   * The pending edits are now part of the session document (BR-008 applies the save
   * request to the in-memory bytes before serializing). Unlike the other adapters —
   * which serialize whole editor state and are therefore idempotent — a PDF export
   * merges a delta, so the renderer must drop what was merged here; leaving it pending
   * makes the next export apply the same markups and inserted runs a second time.
   */
  onMerged?: () => void
}

export interface ControlHandle {
  close: () => void
  setReadiness: (readiness: 'loading' | 'ready' | 'error', extra?: { revision?: string; error?: string }) => void
  bumpRevision: () => void
}

/**
 * Register the executor for this document (BR-003) and serve downstream
 * tool/context/export calls. Returns null when control mode is inactive or
 * the document has no path: target.
 */
export function initControlMode(opts: ControlAdapterOptions): ControlHandle | null {
  if (!CONTROL_MODE) return null
  if (!CONTROL_PATH) {
    console.warn('[control] control=1 without a path: open target — executor not registered')
    return null
  }

  const docIdPromise = sha256Hex(CONTROL_PATH)
  let es: EventSource | null = null
  let closed = false

  const ownerId = ownerIdFor(CONTROL_PATH)
  activeOwner = ownerId
  let occupied = false
  let readiness: 'loading' | 'ready' | 'error' = 'loading'
  let revision: string | null = null
  let loadError: string | null = null
  let fileRev: string | null = null
  const flushStatus = (): void => {
    void docIdPromise.then((id) => {
      if (closed || occupied) return
      void notify(id, 'status', undefined, { readiness, revision, error: loadError }, ownerId)
    })
  }
  const setReadiness = (
    next: 'loading' | 'ready' | 'error',
    extra?: { revision?: string; error?: string },
  ): void => {
    readiness = next
    if (extra?.revision !== undefined) revision = extra.revision
    else if (next === 'ready' && revision == null) revision = fileRev
    loadError = next === 'error' ? extra?.error ?? loadError : extra?.error ?? null
    flushStatus()
  }
  const bumpRevision = (): void => {
    void (async () => {
      if (closed || occupied) return
      revision = await sha256Hex(`${CONTROL_PATH}:${revision ?? ''}:${Date.now()}`)
      flushStatus()
    })()
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let dirtyTimer: ReturnType<typeof setInterval> | null = null
  let lastDirty: boolean | undefined
  /** merged into the session document but not yet acknowledged on disk */
  let unwritten = false
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
    es.onopen = () => console.log(`[control] stream open (docId=${docId.slice(0, 8)}…)`)
    es.addEventListener('hello', () => {
      console.log(`[control] executor registered (${CONTROL_PATH})`)
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
    // INV-004: contracts/control-api.md §2.1 saved + §2.8 dirty
    es.addEventListener('saved', (ev) => {
      let data: { mtimeMs?: unknown } = {}
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }
      if (typeof data.mtimeMs === 'number') mtimeMs = data.mtimeMs
      if (typeof (data as { fileRevision?: unknown }).fileRevision === 'string') {
        fileRev = (data as { fileRevision: string }).fileRevision
      }
      const exportRevision = (data as { exportRevision?: unknown }).exportRevision
      if (exportRevision != null && String(exportRevision) !== String(revision)) {
        return
      }
      unwritten = false
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
    if (
      !call ||
      typeof call.input !== 'object' ||
      call.input === null ||
      Array.isArray(call.input)
    ) {
      await notify(
        docId,
        'tool-result',
        requestId,
        errorExecution('invalid input', call?.name ?? 'unknown'),
      )
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

    const deps = opts.getDeps()
    if (!deps) {
      // UF-003 failure branch: no document until the file finishes loading
      await notify(docId, 'tool-result', requestId, errorExecution('editor not ready', call.name))
      return
    }
    try {
      const execution = await executePdfTool(deps, call)
      await notify(docId, 'tool-result', requestId, execution)
    } catch (e) {
      await notify(
        docId,
        'tool-result',
        requestId,
        errorExecution(
          `tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
          call.name,
        ),
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
    const deps = opts.getDeps()
    if (!deps) {
      await notify(docId, 'context', requestId, { context: 'editor not ready', revision })
      return
    }
    const skill = await import('./ai/pdf-skill').then((m) => m.createPdfSkill(deps))
    await notify(docId, 'context', requestId, { context: skill.buildContext?.() ?? '', revision })
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
      // Apply the CURRENT renderer state to the in-memory bytes first (BR-008:
      // the save request is the same payload a ⌘S/autosave would produce)
      const hadEdits = Boolean(opts.getDirty?.())
      const request = opts.getSaveRequest()
      if (request) {
        const result = await window.pdfApi.save(request)
        if (!result.ok && result.error) {
          await notify(docId, 'export', requestId, { error: `export failed: ${result.error}` })
          return
        }
        // Merged, not yet on disk: the renderer stops listing these edits as pending,
        // so `unwritten` carries the dirty signal until the write is confirmed —
        // otherwise a rejected write (conflict, unwritable target) would leave the host
        // thinking the document is clean while the file still lacks the changes.
        if (hadEdits) unwritten = true
        opts.onMerged?.()
      }
      const exported = await opts.exportBytes()
      if (!exported) {
        await notify(docId, 'export', requestId, { error: 'export failed: no document loaded' })
        return
      }
      const base64 = bytesToBase64(exported.bytes)
      const mtimeMs = await captureMtime()
      await notify(docId, 'export', requestId, {
        base64,
        name: exported.name,
        path: CONTROL_PATH,
        mtimeMs,
        expectedRevision: fileRev,
        exportRevision,
        owner: ownerId,
      })
    } catch (e) {
      // INV-003: an export failure never lands anything on disk
      await notify(docId, 'export', requestId, {
        error: `export failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  /** conflict baseline: mtime of the original file as of adapter init (UF-002) */
  let mtimeMs: number | null = null
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
        const dirty = Boolean(opts.getDirty?.()) || unwritten
        if (dirty === lastDirty) return
        reportDirty(id, dirty)
      }
      tick()
      dirtyTimer = setInterval(tick, 1000)
    })()
  }

  const onVisibility = (): void => {
    if (occupied) return
    if (
      document.visibilityState === 'visible' &&
      (es === null || es.readyState === EventSource.CLOSED)
    ) {
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

  // Clear only the control param once consumed (refresh must not re-arm)
  const url = new URL(location.href)
  if (url.searchParams.has('control')) {
    url.searchParams.delete('control')
    history.replaceState(null, '', url)
  }

  void openStream()
  return { close, setReadiness, bumpRevision }
}

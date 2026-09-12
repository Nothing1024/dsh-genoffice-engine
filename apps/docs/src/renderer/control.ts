/**
 * Control-mode adapter for the AI Docs renderer (genoffice-dsh-control).
 *
 * INV-004 mirror: contracts/control-api.md §2.1 saved + §2.8 dirty — SSE downstream + POST notify
 * upstream, ToolExecution shapes, docId = sha256(absolute path).
 *
 * Only active when the URL carries `control=1` AND a `path:` open target
 * (BR-001). Non-control loads take zero side effects (INV-001). All document
 * changes flow through the editor instance (`executeTool` / Tiptap dispatch);
 * nothing here touches file bytes or IndexedDB snapshots (INV-005).
 */
import type { Editor } from '@tiptap/core'
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import { executeTool, type AiCommentsAccess, type AiHeaderFooterAccess, type AiTrack, type FrozenSelection } from './ai/tools'
import { buildDocContext, getSelectionScope, type NumIds } from './ai/protocol'

// ── module-level capture ──────────────────────────────────────────────
// The app's open flow clears ?open= (and we clear ?control=) from the
// address bar right after mount, so the control flags are read ONCE at
// import time (before any render/effect runs).
const params = new URLSearchParams(location.search)

/** BR-001: control mode active (URL had control=1). Shared with App.tsx for the AI-dock hiding rule. */
export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

/** Original absolute path from the `path:` open target (BR-009 docId source). */
export const CONTROL_PATH: string | null = openTarget.startsWith('path:')
  ? openTarget.slice('path:'.length)
  : null

// ── small helpers ─────────────────────────────────────────────────────

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

/** pick an existing numbering id per kind so inserted lists join real docx numbering */
function currentNumIds(editor: Editor): NumIds {
  let bullet: string | null = null
  let ordered: string | null = null
  editor.state.doc.forEach((node) => {
    if (node.type.name !== 'docListItem' || (bullet !== null && ordered !== null)) return
    const kind = node.attrs.kind as 'bullet' | 'ordered'
    if (kind === 'bullet' && bullet === null) bullet = (node.attrs.numId as string | null) ?? null
    if (kind === 'ordered' && ordered === null) ordered = (node.attrs.numId as string | null) ?? null
  })
  return { bullet, ordered }
}

/** push an upstream notification (BR-002 return shapes are the relay's job) */
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

// ── the adapter ───────────────────────────────────────────────────────

export interface ControlAdapterOptions {
  /** fresh editor accessor (skill-style getEditor(); never a stale instance) */
  getEditor: () => Editor | null
  /** serialize the CURRENT editor state to document bytes (docs: buildDocBytes) */
  exportBytes: () => Promise<{ bytes: Uint8Array; name: string } | null>
  /** persisted-content dirty (desktop close-guard same signal); optional for INV-003 old callers */
  getDirty?: () => boolean
  /** clear the editor dirty source after a successful write-back (BR-004) */
  onSaved?: () => void
  getTrack?: () => AiTrack | undefined
  getComments?: () => AiCommentsAccess | undefined
  getHf?: () => AiHeaderFooterAccess | undefined
  getFrozen?: () => FrozenSelection | null | undefined
}

export interface ControlHandle {
  close: () => void
  setReadiness: (readiness: 'loading' | 'ready' | 'error', extra?: { revision?: string; error?: string }) => void
  bumpRevision: () => void
}

/**
 * Register the executor for this document (BR-003) and serve downstream
 * tool/context/export calls. Returns null when control mode is inactive or
 * the document has no path: target (nothing to bind).
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
  let frozen: FrozenSelection | null = null
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
      opts.onSaved?.()
      reportDirty(docId, false)
    })
    es.onerror = () => {
      if (closed || occupied) {
        es?.close()
        return
      }
      // Never leave the browser's auto-reconnect running: a detached iframe
      // (element removed, document still executing) would reconnect forever
      // and flip-flop with the current document for the relay's single
      // executor slot per docId. Reconnect explicitly, and only while
      // visible; the relay drops the registration while disconnected (BR-003)
      // and in-flight calls time out on our side (BR-010).
      console.warn('[control] stream error — reconnecting…')
      es?.close()
      if (document.visibilityState === 'visible') {
        reconnectTimer = setTimeout(() => { void openStream() }, 1000)
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
      // BR-002 adapter-side validation: invalid input never reaches the executor
      await notify(docId, 'tool-result', requestId, errorExecution('invalid input', call?.name ?? 'unknown'))
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

    const editor = opts.getEditor()
    if (!editor) {
      // UF-001 failure branch: editor not mounted yet (bytes still loading)
      await notify(docId, 'tool-result', requestId, errorExecution('editor not ready', call.name))
      return
    }
    try {
      const execution = await executeTool(
        editor,
        call,
        currentNumIds(editor),
        opts.getTrack?.(),
        undefined,
        opts.getFrozen?.() ?? frozen,
        opts.getComments?.(),
        opts.getHf?.(),
      )
      await notify(docId, 'tool-result', requestId, execution)
    } catch (e) {
      await notify(
        docId,
        'tool-result',
        requestId,
        errorExecution(`tool execution failed: ${e instanceof Error ? e.message : String(e)}`, call.name),
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
    const editor = opts.getEditor()
    if (!editor) {
      await notify(docId, 'context', requestId, { context: 'editor not ready', revision })
      return
    }
    const comments = opts.getComments?.()
    const hf = opts.getHf?.()
    frozen = { scope: getSelectionScope(editor), doc: editor.state.doc }
    await notify(docId, 'context', requestId, {
      context: buildDocContext(editor, frozen.scope, comments?.list(), hf?.read()),
      revision,
    })
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
        await notify(docId, 'export', requestId, {
          error: 'export failed: no document loaded',
        })
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
  const captureMtime = async (): Promise<number | null> => {
    if (mtimeMs !== null) return mtimeMs
    try {
      const resp = await fetch(`/api/file?path=${encodeURIComponent(CONTROL_PATH ?? '')}`)
      const data = (await resp.json()) as { ok?: boolean; mtimeMs?: number | null; fileRevision?: string | null }
      if (data.ok) {
        mtimeMs = data.mtimeMs ?? null
        if (typeof data.fileRevision === 'string') fileRev = data.fileRevision
      }
    } catch {
      /* keep null — conflict check skipped */
    }
    return mtimeMs
  }
  void captureMtime()

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

  // Reconnect when the tab becomes visible again / network returns (ASM-008:
  // hidden tabs throttle EventSource; explicit reopen keeps the registration).
  const onVisibility = (): void => {
    // Reconnect only when the stream is actually down — reopening an already
    // open EventSource would blip the registration on every tab focus.
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

  // Unregister: closing the EventSource drops the relay registration (BR-003).
  const close = (): void => {
    closed = true
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    if (dirtyTimer !== null) clearInterval(dirtyTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    es?.close()
    es = null
  }
  window.addEventListener('pagehide', close)

  // Clear only the control param from the address bar once consumed (refresh
  // must not re-arm; the module-level flags above stay authoritative). The
  // app's own open flow clears ?open=/?file= — deleting them here could race
  // the boot effect that still needs to read them.
  const url = new URL(location.href)
  if (url.searchParams.has('control')) {
    url.searchParams.delete('control')
    history.replaceState(null, '', url)
  }

  void openStream()
  return { close, setReadiness, bumpRevision }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

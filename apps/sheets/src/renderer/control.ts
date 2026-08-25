/**
 * Control-mode adapter for the GenOffice Sheets renderer (genoffice-dsh-office).
 *
 * INV-004 mirror: contracts/control-api.md §2.1 saved + §2.8 dirty — same contract as the docs/
 * markdown adapters (SSE downstream + POST notify upstream, docId =
 * sha256(absolute path)). Active only with `control=1` + a `path:` open
 * target (BR-001); non-control loads take zero side effects (INV-001). All
 * edits go through the Univer instance (executeWorkbookTool / buildSavePayload
 * — INV-005), never direct file writes.
 */
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import type { SheetsSkillDeps } from './ai/tools'
import { buildWorkbookContext, executeWorkbookTool } from './ai/tools'
import { buildSavePayload, type SaveContext } from './save-actions'
import { CONTROL_MODE, CONTROL_PATH } from './control-flags'

export { CONTROL_MODE, CONTROL_PATH }

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function notify(
  docId: string,
  kind: 'tool-result' | 'context' | 'export',
  requestId: string | undefined,
  payload: unknown,
): Promise<void> {
  try {
    await fetch('/api/control/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, kind, requestId, payload }),
    })
  } catch (e) {
    console.error('[control] notify failed:', e)
  }
}

function errorExecution(output: string, summary: string): ToolExecution {
  return { output, isError: true, summary }
}

function fileNameFromPath(path: string | null): string {
  return path?.split('/').pop() ?? 'workbook.xlsx'
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
  /** fresh skill deps accessor (sheetsSkillDeps(); never a stale instance) */
  getDeps: () => SheetsSkillDeps | null
  /** fresh save context (saveContext(); used to assemble the write-back bytes) */
  getSaveContext: () => SaveContext
  /** current workbook bytes (web-bridge exportCurrentBytes; injected so desktop never imports it) */
  exportBytes: ControlExportBytes
  /** persisted-content dirty (desktop close-guard same signal); optional for INV-003 old callers */
  getDirty?: () => boolean
  /** clear the editor dirty source after a successful write-back (BR-004) */
  onSaved?: () => void
}

export interface ControlHandle {
  close: () => void
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
    if (closed) return
    es?.close()
    es = new EventSource(`/api/control/stream?docId=${docId}`)
    es.onopen = () => console.log(`[control] stream open (docId=${docId.slice(0, 8)}…)`)
    es.addEventListener('hello', () => console.log(`[control] executor registered (${CONTROL_PATH})`))
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
      opts.onSaved?.()
      reportDirty(docId, false)
    })
    es.onerror = () => {
      // Never leave the browser's auto-reconnect running: a detached iframe
      // would reconnect forever and flip-flop with the current document for
      // the relay's single executor slot per docId. Reconnect explicitly,
      // and only while visible.
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
      await notify(docId, 'tool-result', requestId, errorExecution('invalid input', call?.name ?? 'unknown'))
      return
    }
    const deps = opts.getDeps()
    if (!deps) {
      // UF-001 failure branch: no editor/workbook until the document finishes
      // loading — must go through the not-ready branch
      await notify(docId, 'tool-result', requestId, errorExecution('editor not ready', call.name))
      return
    }
    try {
      const execution = await executeWorkbookTool(call, deps)
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
    const deps = opts.getDeps()
    if (!deps) {
      await notify(docId, 'context', requestId, { context: 'editor not ready' })
      return
    }
    await notify(docId, 'context', requestId, { context: buildWorkbookContext(deps) })
  }

  const handleExport = async (docId: string, ev: MessageEvent): Promise<void> => {
    let requestId: string | undefined
    try {
      requestId = (JSON.parse(ev.data) as { requestId?: string }).requestId
    } catch {
      return
    }
    try {
      const bytes = await buildExportBytes(opts)
      if (!bytes) {
        await notify(docId, 'export', requestId, { error: 'export failed: no workbook loaded' })
        return
      }
      const base64 = bytesToBase64(bytes)
      const mtimeMs = await captureMtime()
      await notify(docId, 'export', requestId, {
        base64,
        name: fileNameFromPath(CONTROL_PATH),
        path: CONTROL_PATH,
        mtimeMs,
      })
    } catch (e) {
      // INV-003: an export failure never lands anything on disk
      await notify(docId, 'export', requestId, {
        error: `export failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  /**
   * conflict baseline: mtime of the original file as of adapter init (UF-002)
   */
  let mtimeMs: number | null = null
  const captureMtime = async (): Promise<number | null> => {
    if (mtimeMs !== null) return mtimeMs
    try {
      const resp = await fetch(`/api/file?path=${encodeURIComponent(CONTROL_PATH ?? '')}`)
      const data = (await resp.json()) as { ok?: boolean; mtimeMs?: number | null }
      if (data.ok) mtimeMs = data.mtimeMs ?? null
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

  const onVisibility = (): void => {
    // Reconnect only when the stream is actually down — reopening an already
    // open EventSource would blip the registration on every tab focus.
    if (document.visibilityState === 'visible' && (es === null || es.readyState === EventSource.CLOSED)) {
      void openStream()
    }
  }
  const onOnline = (): void => {
    if (es === null || es.readyState === EventSource.CLOSED) void openStream()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)

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
  // app's own open flow clears ?open=/?file=.
  const url = new URL(location.href)
  if (url.searchParams.has('control')) {
    url.searchParams.delete('control')
    history.replaceState(null, '', url)
  }

  void openStream()
  return { close }
}

// ── write-back bytes assembly (BR-008: the only export payload) ─────────

/**
 * Current workbook bytes for the control export: applies the pending edit
 * journal through the SAME save pipeline a ⌘S would use (buildSavePayload +
 * saveWorkbookEdits), then reads back the freshly serialized bytes. When the
 * journal is empty the original bytes are returned untouched.
 */
export async function buildExportBytes(opts: ControlAdapterOptions): Promise<Uint8Array | null> {
  const ctx = opts.getSaveContext()
  const state = ctx.lazyWorkbookRef.current
  if (!state) return null
  const bundle = await buildSavePayload(ctx)
  if (!bundle) {
    // no edits — current bytes are the opened file's bytes
    const current = await opts.exportBytes()
    return current?.bytes ?? null
  }
  const { payload, splitSave, heldPivots, heldTables, heldNames } = bundle
  await window.desktopApi.saveWorkbookEdits({
    ...payload,
    mode: 'save',
    tableAdditions: splitSave && heldTables.length > 0 ? [] : payload.tableAdditions,
    pivotAdditions: splitSave && heldPivots.length > 0 ? [] : payload.pivotAdditions,
    definedNamesState: splitSave ? null : payload.definedNamesState,
  })
  if (splitSave) {
    const after = await window.desktopApi.saveWorkbookEdits({
      sessionId: state.file.sessionId,
      mode: 'save',
      edits: [],
      structuralOps: [],
      chartEdits: [],
      visualEdits: [],
      visualAdditions: [],
      tableAdditions: heldTables,
      pivotAdditions: heldPivots,
      sheetOps: [],
      sheetOrder: [],
      filterStates: [],
      hyperlinkEdits: [],
      cfStates: [],
      dvStates: [],
      pageSetupStates: [],
      noteStates: [],
      pivotCacheRefreshPaths: [],
      pivotRefreshUpdates: [],
      sheetProtections: [],
      sparklineAdditions: [],
      formulaValues: [],
      definedNamesState: heldNames,
      themeState: null,
      workbookProtectionState: null,
      protectedRangeStates: [],
    })
    void after
  }
  const current = await opts.exportBytes()
  return current?.bytes ?? null
}

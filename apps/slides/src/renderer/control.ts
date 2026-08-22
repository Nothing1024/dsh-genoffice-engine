/**
 * Control-mode adapter for the GenOffice Slides renderer (genoffice-dsh-office).
 *
 * INV-004 mirror: contracts/control-api.md — same contract as the other app
 * adapters (SSE downstream + POST notify upstream, docId = sha256(absolute
 * path)). Active only with `control=1` + a `path:` open target (BR-001);
 * non-control loads take zero side effects (INV-001). All edits go through
 * the deck session (slides-skill executeTool over DeckAccess — INV-005),
 * never direct file writes.
 */
import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import { createSlidesSkill, type DeckAccess } from './ai/slides-skill'
import { exportSlidesBytes } from './web-bridge'

// ── module-level capture ──────────────────────────────────────────────
const params = new URLSearchParams(location.search)

/** BR-001: control mode active. Shared with App.tsx for the AI-dock hiding rule. */
export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

/** Original absolute path from the `path:` open target (BR-009 docId source). */
export const CONTROL_PATH: string | null = openTarget.startsWith('path:')
  ? openTarget.slice('path:'.length)
  : null

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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export interface ControlAdapterOptions {
  /** fresh DeckAccess accessor (from the live App state; never stale) */
  getDeckAccess: () => DeckAccess | null
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
    es.onerror = () => {
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
    const access = opts.getDeckAccess()
    if (!access) {
      // UF-002 failure branch: no deck until the document finishes loading
      await notify(docId, 'tool-result', requestId, errorExecution('editor not ready', call.name))
      return
    }
    try {
      // fresh skill per call: cheap, and the access closures read live state
      const skill = createSlidesSkill(access, CONTROL_PATH ?? undefined)
      const execution = await skill.executeTool(call)
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
    const access = opts.getDeckAccess()
    if (!access) {
      await notify(docId, 'context', requestId, { context: 'editor not ready' })
      return
    }
    const skill = createSlidesSkill(access, CONTROL_PATH ?? undefined)
    await notify(docId, 'context', requestId, { context: skill.buildContext?.() ?? '' })
  }

  const handleExport = async (docId: string, ev: MessageEvent): Promise<void> => {
    let requestId: string | undefined
    try {
      requestId = (JSON.parse(ev.data) as { requestId?: string }).requestId
    } catch {
      return
    }
    try {
      const exported = await exportSlidesBytes()
      if (!exported) {
        await notify(docId, 'export', requestId, { error: 'export failed: no deck loaded' })
        return
      }
      const base64 = bytesToBase64(exported.bytes)
      const mtimeMs = await captureMtime()
      await notify(docId, 'export', requestId, {
        base64,
        name: exported.name,
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

  /** conflict baseline: mtime of the original file as of adapter init (UF-002) */
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

  const onVisibility = (): void => {
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
  return { close }
}

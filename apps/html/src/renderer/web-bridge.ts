/**
 * GenOffice HTML — Web bridge.
 *
 * Stand-in for the Electron preload (window.htmlApi / window.projectApi)
 * so the renderer can run in a plain browser tab.
 */
import { bindLoadMeta } from './control'
import {
  defaultAiSettings,
  resolveAiSettings,
  streamForProvider,
} from '@genoffice/ai-provider'
import type {
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@genoffice/ai-provider'
import type { ProjectApi } from '@genoffice/project-store'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentReadResult,
  ExportDocxRequest,
  ExportPdfRequest,
  ExportResult,
  HtmlApi,
  ImageData,
  SaveHtmlRequest,
  SaveHtmlResult,
  UiTheme,
} from '../shared/ipc'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    showOpenFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle[]>
    showSaveFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle>
  }
}

export type WebFileSystemHandle = FileSystemFileHandle & {
  queryPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

window.__GENOFFICE_WEB__ = true

const DB_NAME = 'genoffice-web'
const DB_VERSION = 1
const STORE_HANDLES = 'handles'
const STORE_CHATS = 'chats'

interface WebFileRecord {
  name: string
  kind: 'fs' | 'bytes'
  handle?: WebFileSystemHandle
  bytes?: ArrayBuffer
  mtime: number
  accessedAt: number
  starred?: boolean
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES)
      if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const LANG_KEY = 'genoffice-web-lang'
const THEME_KEY = 'genoffice-web-theme'
const AI_SETTINGS_KEY = 'genoffice-web-ai-settings'
const RELAY_BASE = '/api'

async function relay<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const resp = await fetch(`${RELAY_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (!resp.ok) return null
    return (await resp.json()) as T
  } catch {
    return null
  }
}

async function runPrintJob(payload: Record<string, unknown>): Promise<{
  ok: boolean
  path?: string
  error?: string
  canceled?: boolean
  available?: boolean
  base64?: string
}> {
  const ready = await relay<{ available?: boolean; reason?: string }>('/print/ready')
  if (!ready?.available) {
    return { ok: false, error: ready?.reason ?? 'print-service-unavailable', available: false }
  }
  const started = await relay<{ ok?: boolean; jobId?: string; error?: string }>('/print/jobs', payload)
  if (!started?.ok || !started.jobId) {
    return { ok: false, error: started?.error ?? 'print-job-rejected', available: false }
  }
  const done = await relay<{
    ok?: boolean
    dest?: string
    error?: string
    status?: string
    base64?: string
  }>('/print/jobs/wait', { id: started.jobId })
  if (done?.status === 'cancelled') return { ok: false, error: 'cancelled', canceled: true }
  if (!done?.ok) return { ok: false, error: done?.error ?? 'print-failed' }
  const result: { ok: true; path?: string; base64?: string } = { ok: true }
  if (done.dest) result.path = done.dest
  if (done.base64) result.base64 = done.base64
  return result
}

function newPath(name: string): string {
  return `/webdoc/${crypto.randomUUID()}/${name}`
}

function downloadBytes(data: ArrayBuffer | Uint8Array, name: string): void {
  const blob = new Blob([data as BlobPart])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function readText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  if (bytes.includes(0)) {
    throw new Error('load-error: binary html is not supported')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('load-error: html is not valid UTF-8')
  }
}

async function openRecordBytes(path: string): Promise<{ name: string; data: ArrayBuffer } | null> {
  const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
  if (!rec) return null
  if (rec.kind === 'bytes' && rec.bytes) return { name: rec.name, data: rec.bytes }
  if (rec.kind === 'fs' && rec.handle) {
    try {
      if ((await rec.handle.queryPermission?.({ mode: 'read' })) !== 'granted') {
        await rec.handle.requestPermission?.({ mode: 'read' })
      }
      const file = await rec.handle.getFile()
      return { name: file.name, data: await file.arrayBuffer() }
    } catch {
      return null
    }
  }
  return null
}

function isAbsFsPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('/webdoc/')
}

function isHtmlName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

function abToB64(data: ArrayBuffer): string {
  const u = new Uint8Array(data)
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < u.length; i += chunk) {
    s += String.fromCharCode(...u.subarray(i, i + chunk))
  }
  return btoa(s)
}

async function writeAbsFile(path: string, data: ArrayBuffer): Promise<boolean> {
  try {
    const resp = await fetch(`${RELAY_BASE}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, base64: abToB64(data), overwrite: true }),
    })
    const json = (await resp.json()) as { ok?: boolean }
    return json.ok === true
  } catch {
    return false
  }
}

async function writeRecord(path: string, data: ArrayBuffer): Promise<boolean> {
  if (isAbsFsPath(path)) {
    const ok = await writeAbsFile(path, data)
    if (ok) {
      await idbPut(STORE_HANDLES, path, {
        name: path.split('/').pop() ?? 'document.html',
        kind: 'bytes',
        bytes: data,
        mtime: Date.now(),
        accessedAt: Date.now(),
      })
      return true
    }
  }
  const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
  if (rec?.kind === 'fs' && rec.handle) {
    try {
      if ((await rec.handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
        await rec.handle.requestPermission?.({ mode: 'readwrite' })
      }
      const writable = await rec.handle.createWritable()
      await writable.write(data)
      await writable.close()
      await idbPut(STORE_HANDLES, path, { ...rec, mtime: Date.now(), accessedAt: Date.now() })
      return true
    } catch {
      /* fall back to download */
    }
  }
  downloadBytes(data, rec?.name ?? path.split('/').pop() ?? 'document.html')
  return true
}

async function registerFsHandle(handle: WebFileSystemHandle, name: string): Promise<string> {
  const file = await handle.getFile()
  const path = newPath(name)
  await idbPut(STORE_HANDLES, path, {
    name,
    kind: 'fs',
    handle,
    mtime: file.lastModified,
    accessedAt: Date.now(),
  })
  return path
}

const streamListeners = new Set<(chunk: AiStreamChunk) => void>()
const activeStreams = new Map<string, AbortController>()

function emitChunk(chunk: AiStreamChunk): void {
  for (const listener of streamListeners) {
    try {
      listener(chunk)
    } catch {
      /* ignore */
    }
  }
}

async function runAiStream(request: AiStreamRequest): Promise<void> {
  const { requestId, settings, system, messages } = request
  const tools = request.tools ?? []
  const maxTokens = request.maxTokens ?? 8192
  const provider = settings.provider
  const config = settings.providers?.[provider]
  if (!config?.apiKey) {
    emitChunk({
      requestId,
      type: 'error',
      error:
        provider === 'genspark'
          ? '网页版需要配置自己的模型 API Key，Genspark 登录仅在桌面版可用'
          : `未配置 ${provider} 的 API Key`,
    })
    return
  }
  if (!config.model) {
    emitChunk({ requestId, type: 'error', error: '未配置模型' })
    return
  }
  const controller = new AbortController()
  activeStreams.set(requestId, controller)
  try {
    let stopReason: string | undefined
    await streamForProvider(provider, config, system, messages, tools, maxTokens, {
      signal: controller.signal,
      onDelta: (text) => emitChunk({ requestId, type: 'delta', text }),
      onToolCall: (toolCall) => emitChunk({ requestId, type: 'tool-call', toolCall }),
      onStopReason: (reason) => {
        stopReason = reason
      },
    })
    emitChunk({ requestId, type: 'done', stopReason })
  } catch (err) {
    if (controller.signal.aborted) {
      emitChunk({ requestId, type: 'done' })
    } else {
      emitChunk({
        requestId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    activeStreams.delete(requestId)
  }
}

let pendingOpenConsumed = false
let currentPath: string | null = null
let previewHtml = '<!doctype html><html><body></body></html>'
let previewUrl: string | null = null

function parseOpenTarget(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v) return v
  }
  const m = location.pathname.match(/\/(?:html)\/f\/([A-Za-z0-9_-]+)\/?$/)
  if (m) {
    try {
      const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
      return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))
    } catch {
      /* malformed */
    }
  }
  return null
}

function clearOpenTarget(): void {
  const url = new URL(location.href)
  let changed = false
  for (const key of ['open', 'file']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  const m = url.pathname.match(/^(\/html)\/f\/[A-Za-z0-9_-]+\/?$/)
  if (m) {
    url.pathname = `${m[1]}/`
    changed = true
  }
  if (changed) history.replaceState(null, '', url)
}

async function bytesFromRemote(target: string): Promise<{ data: ArrayBuffer; name: string } | null> {
  try {
    if (target.startsWith('data:')) {
      const comma = target.indexOf(',')
      if (comma < 0) return null
      const meta = target.slice(5, comma)
      const raw = target.slice(comma + 1)
      const bytes = meta.includes(';base64')
        ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(raw))
      const nameMatch = meta.match(/name=([^;]+)/)
      return { data: bytes.buffer as ArrayBuffer, name: nameMatch?.[1] ?? 'inline-file' }
    }
    const isHttp = /^https?:\/\//.test(target)
    const isServer = target.startsWith('server:')
    const isInject = target.startsWith('inject:')
    const isPath = target.startsWith('path:')
    if (!isHttp && !isServer && !isInject && !isPath) return null
    const endpoint = isHttp
      ? `fetch-file?url=${encodeURIComponent(target)}`
      : isServer
        ? `files?path=${encodeURIComponent(target.slice('server:'.length))}`
        : isInject
          ? `inject/${encodeURIComponent(target.slice('inject:'.length))}`
          : `file?path=${encodeURIComponent(target.slice('path:'.length))}`
    const resp = await fetch(`${RELAY_BASE}/${endpoint}`)
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean
      base64?: string
      name?: string
      error?: string
      mtimeMs?: number | null
      fileRevision?: string | null
    }
    if (!resp.ok || !data.ok || !data.base64) {
      if (isPath) throw new Error(`load-error: ${data.error ?? `HTTP ${resp.status}`}`)
      return null
    }
    if (isPath) bindLoadMeta({ mtimeMs: data.mtimeMs, fileRevision: data.fileRevision })
    const bin = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
    return { data: bin.buffer as ArrayBuffer, name: data.name ?? 'remote-file' }
  } catch (error) {
    if (target.startsWith('path:')) throw error
    return null
  }
}

async function openTarget(target: string): Promise<string | null> {
  if (target.startsWith('/webdoc/')) {
    currentPath = target
    return target
  }
  const remote = await bytesFromRemote(target)
  if (!remote) {
    if (target.startsWith('path:')) throw new Error('load-error: empty result for path target')
    return null
  }
  if (!isHtmlName(remote.name) && !target.startsWith('path:')) {
    return null
  }
  const pathHint = target.startsWith('path:') ? target.slice('path:'.length) : ''
  const path = target.startsWith('path:') && isAbsFsPath(pathHint) ? pathHint : newPath(remote.name)
  await idbPut(STORE_HANDLES, path, {
    name: remote.name,
    kind: 'bytes',
    bytes: remote.data,
    mtime: Date.now(),
    accessedAt: Date.now(),
  })
  currentPath = path
  return path
}

function setPreviewBuffer(text: string): void {
  previewHtml = text
  if (previewUrl) URL.revokeObjectURL(previewUrl)
  previewUrl = URL.createObjectURL(new Blob([text], { type: 'text/html' }))
}

const htmlApi: HtmlApi = {
  consumePending: async () => {
    if (pendingOpenConsumed) return null
    pendingOpenConsumed = true
    const target = parseOpenTarget()
    if (!target) return null
    clearOpenTarget()
    return await openTarget(target)
  },

  readFile: async (path) => {
    const opened = await openRecordBytes(path)
    if (!opened) throw new Error('file not found')
    return readText(opened.data)
  },

  updatePreview: (text: string) => {
    setPreviewBuffer(text)
  },

  getPreviewInfo: async () => {
    if (!previewUrl) setPreviewBuffer(previewHtml)
    return { url: previewUrl ?? 'about:blank' }
  },

  setPresentFullScreen: async () => {},
  presentInNewTab: async () => false,

  save: async (request: SaveHtmlRequest): Promise<SaveHtmlResult> => {
    const bytes = new TextEncoder().encode(request.text).buffer as ArrayBuffer
    const suggested = request.suggestedName
      ? String(request.suggestedName).replace(/\.html?$/i, '')
      : request.defaultName
        ? String(request.defaultName).replace(/\.html?$/i, '')
        : 'untitled'
    if (request.mode === 'save' && currentPath) {
      await writeRecord(currentPath, bytes)
      return { ok: true, path: currentPath }
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${suggested}.html`,
          types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
        currentPath = await registerFsHandle(handle, `${suggested}.html`)
        return { ok: true, path: currentPath }
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return { ok: true, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    downloadBytes(bytes, `${suggested}.html`)
    return { ok: true, path: `${suggested}.html` }
  },

  setDirty: () => {},
  onSaveRequest: () => () => {},
  sendSaveRequestAck: () => {},
  onCloseSaveRequest: () => () => {},
  sendCloseSaveResult: () => {},
  onFileRenamed: () => () => {},
  setProvisionalTitle: () => {},

  pickImage: async () => {
    if (!currentPath || !isAbsFsPath(currentPath)) return null
    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/png,image/jpeg,image/gif'
      input.style.display = 'none'
      document.body.appendChild(input)
      input.onchange = () => {
        const picked = input.files?.[0] ?? null
        input.remove()
        resolve(picked)
      }
      input.oncancel = () => {
        input.remove()
        resolve(null)
      }
      input.click()
    })
    if (!file) return null
    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    const buf = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk))
    return await htmlApi.saveImage({ base64: btoa(binary), ext })
  },

  saveImage: async (data) => {
    if (!currentPath || !isAbsFsPath(currentPath)) return null
    const ready = await relay<{ available?: boolean; reason?: string }>('/markdown/assets/ready')
    if (!ready?.available) return null
    const res = await relay<{ ok?: boolean; relative?: string; error?: string }>('/markdown/assets', {
      documentPath: currentPath,
      bytesBase64: data.base64,
      ext: data.ext,
      name: `image.${data.ext}`,
    })
    return res?.ok && res.relative ? res.relative : null
  },

  readImage: async (src): Promise<ImageData | null> => {
    if (!currentPath || !isAbsFsPath(currentPath) || typeof src !== 'string') return null
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.includes('..') || src.startsWith('/') || src.startsWith('\\')) {
      return null
    }
    const docDir = currentPath.replace(/[/\\][^/\\]+$/, '')
    const abs = `${docDir}/${src}`
    try {
      const resp = await fetch(`${RELAY_BASE}/file?path=${encodeURIComponent(abs)}`)
      const json = (await resp.json()) as { ok?: boolean; base64?: string; name?: string }
      if (!json.ok || !json.base64) return null
      const ext = (json.name ?? abs).split('.').pop()?.toLowerCase() ?? ''
      const mime: ImageData['mime'] =
        ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
      if (ext !== 'png' && ext !== 'gif' && ext !== 'jpg' && ext !== 'jpeg') return null
      return { base64: json.base64, mime }
    } catch {
      return null
    }
  },

  pickAttachments: async () => null,
  addAttachmentPaths: async (): Promise<AttachmentAddResult> => ({
    accepted: [],
    rejected: ['attachments are not available in the web HTML editor'],
  }),
  addPastedImage: async (): Promise<AttachmentAddResult> => ({
    accepted: [],
    rejected: ['attachments are not available in the web HTML editor'],
  }),
  readAttachment: async (): Promise<AttachmentReadResult> => ({
    ok: false,
    error: 'unsupported',
  }),
  readAttachmentImage: async (): Promise<AttachmentImageResult> => ({
    ok: false,
    error: 'unsupported',
  }),
  getPathForFile: () => '',

  onExportRequest: () => () => {},
  onPrintRequest: () => () => {},
  onChromePressed: () => () => {},

  exportDocx: async (request: ExportDocxRequest): Promise<ExportResult> => {
    const destHint = (request as ExportDocxRequest & { dest?: string }).dest
    const stem = String(request.suggestedName || 'html').replace(/\.[^.]+$/, '')
    const dest =
      typeof destHint === 'string' && destHint.startsWith('/')
        ? destHint
        : currentPath && currentPath.startsWith('/')
          ? `${currentPath.replace(/\/[^/]+$/, '')}/${stem}.docx`
          : ''
    const ready = await relay<{ available?: boolean; reason?: string }>('/html/docx/ready')
    if (!ready?.available) {
      return { ok: false, error: ready?.reason ?? 'html-to-docx-unavailable' }
    }
    if (!dest) return { ok: false, error: 'missing dest' }
    if (!request.html) return { ok: false, error: 'missing html' }
    const started = await relay<{ ok?: boolean; jobId?: string; error?: string; available?: boolean }>(
      '/html/docx/jobs',
      { html: request.html, dest, app: 'html' },
    )
    if (!started?.ok || !started.jobId) {
      return { ok: false, error: started?.error ?? 'html-docx-rejected' }
    }
    const done = await (async () => {
      try {
        const resp = await fetch(`${RELAY_BASE}/html/docx/jobs/wait`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: started.jobId }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!resp.ok) return null
        return (await resp.json()) as {
          ok?: boolean
          dest?: string
          error?: string
          status?: string
        }
      } catch {
        return null
      }
    })()
    if (done?.status === 'cancelled') return { ok: true, canceled: true }
    if (!done?.ok) return { ok: false, error: done?.error ?? 'html-docx-failed' }
    const path = done.dest ?? dest
    window.open(`/docs/?open=${encodeURIComponent(`path:${path}`)}`, '_blank', 'noopener')
    return { ok: true, path }
  },

  exportPdf: async (request: ExportPdfRequest): Promise<ExportResult> => {
    const destHint = (request as ExportPdfRequest & { dest?: string }).dest
    const stem = String(request.suggestedName || 'html').replace(/\.[^.]+$/, '')
    const dest =
      typeof destHint === 'string' && destHint.startsWith('/')
        ? destHint
        : currentPath && currentPath.startsWith('/')
          ? `${currentPath.replace(/\/[^/]+$/, '')}/${stem}.pdf`
          : `/tmp/genoffice-web-print/${stem}.pdf`
    if (!request.html) return { ok: false, error: 'missing print html' }
    const printed = await runPrintJob({ app: 'html', dest, html: request.html })
    if (printed.canceled) return { ok: true, canceled: true }
    if (!printed.ok) return { ok: false, error: printed.error ?? 'print-failed' }
    return { ok: true, path: printed.path ?? dest }
  },

  getLanguage: async () => {
    const v = localStorage.getItem(LANG_KEY)
    const langs = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'th', 'id', 'ru', 'ar'] as const
    return (langs as readonly string[]).includes(v ?? '') ? (v as never) : 'zh'
  },
  onLanguageChanged: (handler) => {
    window.addEventListener('storage', (e) => {
      if (e.key === LANG_KEY) {
        const v = localStorage.getItem(LANG_KEY) ?? 'zh'
        handler(v as never)
      }
    })
    return () => {}
  },

  getTheme: async (): Promise<UiTheme> => {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  },
  onThemeChanged: (handler) => {
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_KEY) {
        const v = localStorage.getItem(THEME_KEY) ?? 'system'
        handler(v as UiTheme)
      }
    })
    return () => {}
  },
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: () => () => {},
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: () => () => {},

  aiGskStatus: async () => ({ loggedIn: false }),
  getAiSettings: async (): Promise<AiSettings> => {
    try {
      const raw = localStorage.getItem(AI_SETTINGS_KEY)
      if (raw) return resolveAiSettings(JSON.parse(raw) as AiSettings, defaultAiSettings())
    } catch {
      /* fall through */
    }
    return defaultAiSettings()
  },

  aiStream: async (request) => {
    void runAiStream(request)
  },

  aiStreamCancel: async (requestId) => {
    activeStreams.get(requestId)?.abort()
  },

  onAiStream: (handler) => {
    streamListeners.add(handler)
    return () => streamListeners.delete(handler)
  },

  imageSearch: async (query, maxResults) => {
    const ready = await fetch(`${RELAY_BASE}/providers/ready`).then((r) => r.json()).catch(() => null)
    if (!ready?.imageSearch?.available) {
      return { images: [], method: 'error', error: ready?.imageSearch?.reason ?? 'image-search-unconfigured' }
    }
    try {
      const resp = await fetch(`${RELAY_BASE}/search/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults: maxResults ?? 5 }),
      })
      return (await resp.json()) as { images: Array<{ title?: string; imageUrl: string }>; method: string; error?: string }
    } catch (e) {
      return { images: [], method: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  },

  fetchImage: async (url) => {
    if (!/^https?:\/\//i.test(url)) return null
    try {
      const resp = await fetch(`${RELAY_BASE}/fetch-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = (await resp.json()) as { base64?: string; mime?: string; error?: string }
      if (!data.base64) return null
      const mime: ImageData['mime'] =
        data.mime === 'image/jpeg' || data.mime === 'image/gif' ? data.mime : 'image/png'
      return { base64: data.base64, mime }
    } catch {
      return null
    }
  },

  aiGenerateImage: async (op) => {
    const ready = await fetch(`${RELAY_BASE}/providers/ready`).then((r) => r.json()).catch(() => null)
    if (!ready?.generate?.available) {
      return { error: ready?.generate?.reason ?? 'generate-provider-unconfigured' }
    }
    try {
      const resp = await fetch(`${RELAY_BASE}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: op.prompt, aspectRatio: op.aspectRatio }),
      })
      return (await resp.json()) as { url?: string; error?: string }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  },

  webSearch: async (query, maxResults) => {
    try {
      const resp = await fetch(`${RELAY_BASE}/search/web`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults: maxResults ?? 5 }),
      })
      if (!resp.ok) throw new Error(`relay HTTP ${resp.status}`)
      const data = (await resp.json()) as {
        results: Array<{ title: string; url: string; snippet: string }>
        method: string
        error?: string
      }
      if (data.method === 'error') throw new Error(data.error ?? 'search failed')
      return { results: data.results, method: data.method }
    } catch (e) {
      return {
        results: [],
        method: 'error',
        error: e instanceof Error ? e.message : String(e),
        answer: `联网搜索不可用（需要本地中继服务）：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
}

type PartialProjectApi = Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>

const DEFAULT_PROJECT_ID = 'web-default'

function stableChatId(filePath: string | null, tempChatId?: string): string {
  if (tempChatId) return tempChatId
  return filePath ? `file-${filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)}` : 'default'
}

interface StoredChatMessage {
  seq: number
  ts: string
  role: 'user' | 'assistant'
  text: string
  fileRef?: string
  tools?: unknown[]
  attachments?: unknown[]
}

const projectApi: PartialProjectApi = {
  resolveChat: async ({ filePath, tempChatId }) => ({
    projectId: DEFAULT_PROJECT_ID,
    chatId: stableChatId(filePath, tempChatId),
  }),

  appendChat: async ({ projectId, chatId, role, text, tools, attachments }) => {
    const key = `${projectId}:${chatId}`
    const existing = (await idbGet<StoredChatMessage[]>(STORE_CHATS, key)) ?? []
    existing.push({
      seq: existing.length,
      ts: new Date().toISOString(),
      role,
      text,
      tools: tools as unknown[] | undefined,
      attachments: attachments as unknown[] | undefined,
    })
    await idbPut(STORE_CHATS, key, existing)
  },

  loadChat: async ({ projectId, chatId, limit }) => {
    const existing = (await idbGet<StoredChatMessage[]>(STORE_CHATS, `${projectId}:${chatId}`)) ?? []
    return (limit ? existing.slice(-limit) : existing) as never
  },

  rebindChat: async ({ projectId, tempChatId, newChatId, newFilePath }) => {
    const oldKey = `${projectId}:${tempChatId}`
    const existing = await idbGet<StoredChatMessage[]>(STORE_CHATS, oldKey)
    if (existing) {
      const newKey = `${projectId}:${newChatId ?? stableChatId(newFilePath ?? null)}`
      await idbPut(STORE_CHATS, newKey, existing)
      if (newKey !== oldKey) await idbDelete(STORE_CHATS, oldKey)
    }
    return { projectId, chatId: newChatId ?? stableChatId(newFilePath ?? null) }
  },
}

if (typeof window !== 'undefined') {
  window.htmlApi = htmlApi
  window.projectApi = projectApi
}

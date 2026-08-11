/**
 * GenOffice Markdown — Web bridge.
 *
 * Stand-in for the Electron preload bridge (window.markdownApi / window.projectApi)
 * that lets the *unmodified* markdown renderer run in a plain browser tab.
 * Uses the same shared IndexedDB "genoffice-web" database as the docs bridge,
 * so files opened on the home screen / in docs show up here and vice versa.
 */
import {
  AI_PROVIDERS,
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
  ExportDocxRequest,
  ExportPdfRequest,
  ExportResult,
  ImageData,
  MarkdownApi,
  SaveMarkdownRequest,
  SaveMarkdownResult,
  SaveMode,
  UiTheme,
} from '../shared/ipc'

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

// ────────────────────────────────────────────────────────────
// Shared IndexedDB (same "genoffice-web" DB as docs/shell bridges)
// ────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const LANG_KEY = 'genoffice-web-lang'
const THEME_KEY = 'genoffice-web-theme'
const AI_SETTINGS_KEY = 'genoffice-web-ai-settings'
const RELAY_BASE = '/api'

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
  return new TextDecoder('utf-8').decode(data)
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

async function writeRecord(path: string, data: ArrayBuffer): Promise<boolean> {
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
  downloadBytes(data, rec?.name ?? path.split('/').pop() ?? 'document.md')
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

// ────────────────────────────────────────────────────────────
// AI streaming (browser-direct, same as the docs bridge)
// ────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────
// window.markdownApi
// ────────────────────────────────────────────────────────────

let pendingOpenConsumed = false
/** main-process equivalent of savePathByWc: the path of the current document */
let currentPath: string | null = null

// ────────────────────────────────────────────────────────────
// URL-driven file opening (same forms as the docs bridge:
// ?open= / ?file= / /markdown/f/<base64url>; targets: /webdoc/…,
// https://… (relay proxy), data:…, server:<relpath>)
// ────────────────────────────────────────────────────────────

function parseOpenTarget(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v) return v
  }
  const m = location.pathname.match(/\/(?:docs|markdown)\/f\/([A-Za-z0-9_-]+)\/?$/)
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
  const m = url.pathname.match(/^(\/(?:docs|markdown))\/f\/[A-Za-z0-9_-]+\/?$/)
  if (m) {
    url.pathname = m[1] + '/'
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
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      ok: boolean
      base64?: string
      name?: string
      error?: string
    }
    if (!data.ok || !data.base64) return null
    const bin = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
    return { data: bin.buffer as ArrayBuffer, name: data.name ?? 'remote-file' }
  } catch {
    return null
  }
}

async function openTarget(target: string): Promise<string | null> {
  // synthetic id → local file
  if (target.startsWith('/webdoc/')) {
    currentPath = target
    return target
  }
  // remote / data: / server: → pull bytes and register as a local document
  const remote = await bytesFromRemote(target)
  if (!remote) return null
  if (!remote.name.toLowerCase().endsWith('.md') && !remote.name.toLowerCase().endsWith('.markdown')) {
    return null
  }
  const path = newPath(remote.name)
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

const markdownApi: MarkdownApi = {
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

  save: async (request: SaveMarkdownRequest): Promise<SaveMarkdownResult> => {
    const text = request.text
    const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
    const suggested = request.suggestedName
      ? String(request.suggestedName).replace(/\.md$/i, '')
      : 'untitled'
    // save to the already-granted path
    if (request.mode === 'save' && currentPath) {
      await writeRecord(currentPath, bytes)
      return { ok: true, path: currentPath }
    }
    // first save / save-as: pick a destination
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${suggested}.md`,
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
        currentPath = await registerFsHandle(handle, `${suggested}.md`)
        return { ok: true, path: currentPath }
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return { ok: true, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    downloadBytes(bytes, `${suggested}.md`)
    return { ok: true, path: `${suggested}.md` }
  },

  setDirty: () => {},
  onSaveRequest: () => () => {},
  sendSaveRequestAck: () => {},
  onCloseSaveRequest: () => () => {},
  sendCloseSaveResult: () => {},
  onFileRenamed: () => () => {},

  pickImage: async () => {
    // browser has no "document directory" to copy images into
    return null
  },

  saveImage: async () => null,

  readImage: async (): Promise<ImageData | null> => null,

  onExportRequest: () => () => {},

  exportDocx: async (request: ExportDocxRequest): Promise<ExportResult> => {
    const bytes = Uint8Array.from(atob(request.base64), (c) => c.charCodeAt(0))
    const safeName = request.suggestedName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) || 'untitled'
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${safeName}.docx`,
          types: [
            {
              description: 'Word 文档',
              accept: {
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
                  '.docx',
                ],
              },
            },
          ],
        })
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
        const path = await registerFsHandle(handle, `${safeName}.docx`)
        if (request.mode === 'openInDocs') {
          // open the exported document in the AI Docs web app
          window.open(`/docs/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
        }
        return { ok: true, path }
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return { ok: true, canceled: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    downloadBytes(bytes, `${safeName}.docx`)
    return { ok: true, path: `${safeName}.docx` }
  },

  exportPdf: async (_request: ExportPdfRequest): Promise<ExportResult> => ({
    ok: false,
    error: '网页版请使用浏览器打印（Ctrl/Cmd+P → 另存为 PDF）导出',
  }),

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
      return { results: data.results }
    } catch (e) {
      return {
        results: [],
        answer: `联网搜索不可用（需要本地中继服务）：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
}

// ────────────────────────────────────────────────────────────
// window.projectApi (chat persistence, minimal IndexedDB impl)
// ────────────────────────────────────────────────────────────

type PartialProjectApi = Pick<
  ProjectApi,
  'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'
>

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

// ────────────────────────────────────────────────────────────
// Drag & drop: drop a local file onto the page to open it
// ────────────────────────────────────────────────────────────

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function installFileDrop(): void {
  let overlay: HTMLDivElement | null = null

  const showOverlay = (visible: boolean, label: string) => {
    if (visible && !overlay) {
      overlay = document.createElement('div')
      overlay.textContent = label
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '9999',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '22px',
        fontWeight: '600',
        color: 'var(--color-text-primary)',
        background: 'var(--color-bg-overlay)',
        border: '3px dashed var(--color-border-brand)',
        pointerEvents: 'none',
      })
      document.body.appendChild(overlay)
    } else if (!visible && overlay) {
      overlay.remove()
      overlay = null
    }
  }

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    if ((e.target as HTMLElement).closest?.('.ai-panel')) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    showOverlay(true, '松开以打开文档')
  })

  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) showOverlay(false, '')
  })

  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files.length) return
    if ((e.target as HTMLElement).closest?.('.ai-panel')) return
    e.preventDefault()
    showOverlay(false, '')
    const item = e.dataTransfer.items?.[0]
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = extOf(file.name)
    try {
      const data = await file.arrayBuffer()
      if (ext === 'md' || ext === 'markdown') {
        const path = newPath(file.name)
        if (item && typeof (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle === 'function') {
          const handle = await (item as DataTransferItem & { getAsFileSystemHandle: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle()
          if (handle?.kind === 'file') {
            await idbPut(STORE_HANDLES, path, {
              name: file.name,
              kind: 'fs',
              handle,
              mtime: file.lastModified,
              accessedAt: Date.now(),
            })
            currentPath = path
            window.open(`/markdown/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
            return
          }
        }
        await idbPut(STORE_HANDLES, path, {
          name: file.name,
          kind: 'bytes',
          bytes: data,
          mtime: file.lastModified,
          accessedAt: Date.now(),
        })
        currentPath = path
        window.open(`/markdown/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
        return
      }
      if (ext === 'docx') {
        const path = newPath(file.name)
        await idbPut(STORE_HANDLES, path, {
          name: file.name,
          kind: 'bytes',
          bytes: data,
          mtime: file.lastModified,
          accessedAt: Date.now(),
        })
        window.open(`/docs/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
        return
      }
      // eslint-disable-next-line no-alert
      alert(`网页版暂不支持打开 .${ext} 文件（仅桌面版可用）`)
    } catch {
      /* fall through */
    }
  })
}

// ────────────────────────────────────────────────────────────
// Install
// ────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.markdownApi = markdownApi
  window.projectApi = projectApi
  installFileDrop()
}

export const WEB_PROVIDERS = AI_PROVIDERS

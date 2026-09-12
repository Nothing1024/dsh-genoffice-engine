/**
 * GenOffice Docs — Web bridge.
 *
 * Stand-in for the Electron preload bridge (`window.desktop` / `window.projectApi`)
 * that lets the *unmodified* renderer run in a plain browser tab:
 *
 *   - open/save documents  → File System Access API (fallback: <input>/download)
 *   - recent files, recovery copies, chat history → IndexedDB
 *   - theme / language / AI settings → localStorage (inert INV-001 fallback;
 *     control=1 uses the DSH agent, not in-browser BYOK)
 *   - web/image search, image fetch → optional local relay server (web/server.mjs)
 *
 * This file is only included by the web build (vite.web.config.ts); the desktop
 * build never sees it.
 */
import { bindLoadMeta } from './control'
import {
  chatForProvider,
  defaultAiSettings,
  resolveAiSettings,
  streamForProvider,
} from '@genoffice/ai-provider'
import type {
  AiChatRequest,
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  GenSparkAccountStatus,
} from '@genoffice/ai-provider'
// subpath imports keep node-only modules (parse.ts/pdf.ts) out of the browser bundle
import { docxToText } from '@genoffice/file-parse/docx'
import { pptxToText } from '@genoffice/file-parse/pptx'
import { xlsxToText } from '@genoffice/file-parse/xlsx'
import type { ProjectApi } from '@genoffice/project-store'
import type { ChatMessage, ProjectSummary, TimelineEntry } from '@genoffice/project-store'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  AutoSaveDefault,
  DecryptOpenResult,
  DesktopApi,
  DocsTabInfo,
  MenuCommand,
  OpenDocxResult,
  OpenFileResult,
  PickImageResult,
  UiTheme,
} from '../shared/ipc'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    showOpenFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle[]>
    showSaveFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle>
  }
}

/** FileSystemHandle with the (lib.dom-missing) permission methods of the File System Access API */
export type WebFileSystemHandle = FileSystemFileHandle & {
  queryPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

window.__GENOFFICE_WEB__ = true

// ────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────

const LANG_KEY = 'genoffice-web-lang'
const THEME_KEY = 'genoffice-web-theme'
const AI_SETTINGS_KEY = 'genoffice-web-ai-settings'
const RELAY_BASE = '/api'

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function fileName(path: string): string {
  return path.split('/').pop() ?? 'document'
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}


function isAbsFsPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('/webdoc/')
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const

function isEncryptedDocxBytes(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data)
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== CFB_MAGIC[i]) return false
  }
  const name = 'EncryptedPackage'
  const needle = new Uint8Array(name.length * 2)
  for (let i = 0; i < name.length; i++) {
    needle[i * 2] = name.charCodeAt(i)
    needle[i * 2 + 1] = 0
  }
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
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

function b64ToAb(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const diskPasswords = new Map<string, string>()
const desiredPasswords = new Map<string, { password: string | null; revision: number }>()
let pendingNewPassword: { password: string | null; revision: number } | null = null
let nextIntentRevision = 1

function passwordForSave(path: string | null): string | null {
  if (path) {
    const intent = desiredPasswords.get(path)
    if (intent && 'password' in intent) return intent.password
    return diskPasswords.get(path) ?? null
  }
  return pendingNewPassword?.password ?? null
}

async function persistOpenedBytes(path: string, name: string, data: ArrayBuffer): Promise<void> {
  await persistRecord(path, {
    name,
    kind: 'bytes',
    bytes: data,
    mtime: Date.now(),
    accessedAt: Date.now(),
  })
}

async function resultFromBytes(
  path: string,
  name: string,
  data: ArrayBuffer,
  persist = true,
): Promise<OpenDocxResult> {
  if (persist) await persistOpenedBytes(path, name, data)
  if (isEncryptedDocxBytes(data) && !diskPasswords.has(path)) {
    return { needsPassword: true, path, name }
  }
  if (isEncryptedDocxBytes(data) && diskPasswords.has(path)) {
    const decrypted = await decryptViaRelay(data, diskPasswords.get(path) ?? '')
    if (!decrypted.ok || !decrypted.data) return { needsPassword: true, path, name }
    return {
      path,
      name,
      data: decrypted.data,
      hash: await sha256Hex(data),
      encrypted: true,
    }
  }
  return { path, name, data, hash: await sha256Hex(data) }
}

async function decryptViaRelay(
  data: ArrayBuffer,
  password: string,
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; reason: 'wrong-password' | 'unsupported' | 'error'; error?: string }> {
  const ready = await relay<{ available?: boolean; reason?: string }>('/docs/crypto/ready')
  if (!ready?.available) {
    return { ok: false, reason: 'unsupported', error: ready?.reason ?? 'docs-crypto-unavailable' }
  }
  const res = await relay<{ ok?: boolean; base64?: string; reason?: string; error?: string }>('/docs/decrypt', {
    bytesBase64: abToB64(data),
    password,
  })
  if (!res?.ok || !res.base64) {
    const reason =
      res?.reason === 'wrong-password' || res?.reason === 'unsupported' ? res.reason : 'error'
    return { ok: false, reason, error: res?.error ?? 'decrypt-failed' }
  }
  return { ok: true, data: b64ToAb(res.base64) }
}

async function encryptViaRelay(
  data: ArrayBuffer,
  password: string,
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }> {
  const ready = await relay<{ available?: boolean; reason?: string }>('/docs/crypto/ready')
  if (!ready?.available) {
    return { ok: false, error: ready?.reason ?? 'docs-crypto-unavailable' }
  }
  const res = await relay<{ ok?: boolean; base64?: string; error?: string }>('/docs/encrypt', {
    bytesBase64: abToB64(data),
    password,
  })
  if (!res?.ok || !res.base64) return { ok: false, error: res?.error ?? 'encrypt-failed' }
  return { ok: true, data: b64ToAb(res.base64) }
}

async function prepareSaveBytes(
  path: string | null,
  data: ArrayBuffer,
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }> {
  const password = passwordForSave(path)
  if (!password) return { ok: true, data }
  const encrypted = await encryptViaRelay(data, password)
  if (!encrypted.ok) return encrypted
  if (path) diskPasswords.set(path, password)
  return encrypted
}

async function writeAbsFile(path: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${RELAY_BASE}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, base64: abToB64(data), overwrite: true }),
    })
    const json = (await resp.json()) as { ok?: boolean; error?: string }
    if (!json.ok) return { ok: false, error: json.error ?? `HTTP ${resp.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function downloadBytes(data: ArrayBuffer, name: string): void {
  const blob = new Blob([data])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function hiddenInput(accept: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.style.display = 'none'
  document.body.appendChild(input)
  return input
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function relay<T>(path: string, body?: unknown, init?: RequestInit): Promise<T | null> {
  try {
    const resp = await fetch(`${RELAY_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      ...init,
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

// ────────────────────────────────────────────────────────────
// IndexedDB persistence
// ────────────────────────────────────────────────────────────

const DB_NAME = 'genoffice-web'
const DB_VERSION = 1
const STORE_HANDLES = 'handles' // path → { name, kind, handle?|bytes?, mtime, accessedAt }
const STORE_RECOVERY = 'recovery' // path → ArrayBuffer
const STORE_CHATS = 'chats' // `${projectId}:${chatId}` → ChatMessage[]

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES)
      if (!db.objectStoreNames.contains(STORE_RECOVERY)) db.createObjectStore(STORE_RECOVERY)
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

async function idbAllKeys(store: string): Promise<string[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
  })
}

// ────────────────────────────────────────────────────────────
// File registry (synthetic paths → FileSystemFileHandle | bytes)
// ────────────────────────────────────────────────────────────

interface WebFileRecord {
  name: string
  kind: 'fs' | 'bytes'
  /** persisted FileSystemFileHandle (Chromium) — re-acquires permission on open */
  handle?: WebFileSystemHandle
  /** fallback payload for browsers without the File System Access API */
  bytes?: ArrayBuffer
  mtime: number
  accessedAt: number
}

/** in-memory registry (persisted to IndexedDB on open) */
const fileRegistry = new Map<string, WebFileRecord>()
/** files handed in via drag&drop / getPathForFile — bytes-only, not persisted */
const transientFiles = new Map<string, File>()

const DOCX_PICKER_TYPES = [
  {
    description: 'Word 文档',
    accept: {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
  },
]

function newPath(name: string): string {
  return `/webdoc/${crypto.randomUUID()}/${name}`
}

async function persistRecord(path: string, rec: WebFileRecord): Promise<void> {
  // bytes payloads can be large; keep them out of IndexedDB unless unavoidable
  if (rec.kind === 'bytes') {
    fileRegistry.set(path, rec)
    return
  }
  fileRegistry.set(path, rec)
  try {
    await idbPut(STORE_HANDLES, path, rec)
  } catch {
    /* quota errors are non-fatal */
  }
}

async function loadRecord(path: string): Promise<WebFileRecord | undefined> {
  const mem = fileRegistry.get(path)
  if (mem) return mem
  const stored = await idbGet<WebFileRecord>(STORE_HANDLES, path)
  if (stored) fileRegistry.set(path, stored)
  return stored
}

async function openRecordBytes(path: string): Promise<{ name: string; data: ArrayBuffer } | null> {
  const rec = await loadRecord(path)
  if (!rec) {
    const t = transientFiles.get(path)
    if (t) return { name: t.name, data: await t.arrayBuffer() }
    return null
  }
  if (rec.kind === 'bytes' && rec.bytes) return { name: rec.name, data: rec.bytes }
  if (rec.kind === 'fs' && rec.handle) {
    try {
      if ((await rec.handle.queryPermission!({ mode: 'read' })) !== 'granted') {
        await rec.handle.requestPermission!({ mode: 'read' })
      }
      const file = await rec.handle.getFile()
      return { name: file.name, data: await file.arrayBuffer() }
    } catch {
      return null
    }
  }
  return null
}

async function loadHandle(handle: WebFileSystemHandle): Promise<OpenDocxResult> {
  try {
    const file = await handle.getFile()
    if (!file.name.toLowerCase().endsWith('.docx')) return null
    const data = await file.arrayBuffer()
    const path = newPath(file.name)
    await persistRecord(path, {
      name: file.name,
      kind: 'fs',
      handle,
      mtime: file.lastModified,
      accessedAt: Date.now(),
    })
    return await resultFromBytes(path, file.name, data, false)
  } catch {
    return null
  }
}

/** <input type=file> fallback (Firefox / Safari / non-secure contexts) */
function pickViaInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = hiddenInput(accept)
    input.onchange = () => {
      const file = input.files?.[0] ?? null
      input.remove()
      resolve(file)
    }
    input.oncancel = () => {
      input.remove()
      resolve(null)
    }
    input.click()
  })
}

// ────────────────────────────────────────────────────────────
// Settings (localStorage)
// ────────────────────────────────────────────────────────────

function readLang(): 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar' {
  const v = localStorage.getItem(LANG_KEY)
  const langs = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'th', 'id', 'ru', 'ar'] as const
  return (langs as readonly string[]).includes(v ?? '') ? (v as never) : 'zh'
}

function readTheme(): UiTheme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function readAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY)
    if (raw) return resolveAiSettings(JSON.parse(raw) as AiSettings, defaultAiSettings())
  } catch {
    /* fall through to defaults */
  }
  return defaultAiSettings()
}

// ────────────────────────────────────────────────────────────
// AI streaming (runs @genoffice/ai-provider in the browser)
// ────────────────────────────────────────────────────────────

const streamListeners = new Set<(chunk: AiStreamChunk) => void>()
const activeStreams = new Map<string, AbortController>()

function emitChunk(chunk: AiStreamChunk): void {
  for (const listener of streamListeners) {
    try {
      listener(chunk)
    } catch {
      /* listener errors are non-fatal */
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
          ? '网页版需要配置自己的模型 API Key（面板右上角 ⚙），Genspark 登录仅在桌面版可用'
          : `未配置 ${provider} 的 API Key（面板右上角 ⚙ 设置）`,
    })
    return
  }
  if (!config.model) {
    emitChunk({ requestId, type: 'error', error: '未配置模型（面板右上角 ⚙ 设置）' })
    return
  }
  const controller = new AbortController()
  activeStreams.set(requestId, controller)
  let lastPing = 0
  const ping = () => {
    const now = Date.now()
    if (now - lastPing < 5_000) return
    lastPing = now
    emitChunk({ requestId, type: 'ping' })
  }
  try {
    let stopReason: string | undefined
    await streamForProvider(provider, config, system, messages, tools, maxTokens, {
      signal: controller.signal,
      onDelta: (text) => emitChunk({ requestId, type: 'delta', text }),
      onToolCall: (toolCall) => emitChunk({ requestId, type: 'tool-call', toolCall }),
      onActivity: ping,
      onStopReason: (reason) => {
        stopReason = reason
      },
    })
    emitChunk({ requestId, type: 'done', stopReason })
  } catch (err) {
    if (controller.signal.aborted) {
      emitChunk({ requestId, type: 'done' })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      const isTimeout = message.includes('timeout') || message.includes('Timeout')
      emitChunk({
        requestId,
        type: 'error',
        error: message,
        errorCode: isTimeout ? 'timeout' : undefined,
      })
    }
  } finally {
    activeStreams.delete(requestId)
  }
}

// ────────────────────────────────────────────────────────────
// Attachments
// ────────────────────────────────────────────────────────────

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yml', 'yaml', 'log', 'ini', 'toml',
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

function registerFileAsAttachment(file: File): AttachmentMeta | { error: string } {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { error: `${file.name} 超过 50MB 限制` }
  }
  const path = newPath(file.name)
  transientFiles.set(path, file)
  return { path, name: file.name, ext: extOf(file.name), sizeBytes: file.size }
}

function buildAddResult(
  files: File[],
): { accepted: AttachmentMeta[]; rejected: string[] } {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const file of files) {
    const meta = registerFileAsAttachment(file)
    if ('error' in meta) rejected.push(meta.error)
    else accepted.push(meta)
  }
  return { accepted, rejected }
}

async function extractAttachmentText(file: File): Promise<{ ok: boolean; text?: string; error?: string }> {
  const ext = extOf(file.name)
  try {
    if (TEXT_EXTS.has(ext)) {
      return { ok: true, text: await file.text() }
    }
    if (ext === 'docx') {
      return { ok: true, text: await docxToText(new Uint8Array(await file.arrayBuffer())) }
    }
    if (ext === 'pptx' || ext === 'ppt') {
      return { ok: true, text: await pptxToText(new Uint8Array(await file.arrayBuffer())) }
    }
    if (ext === 'xlsx' || ext === 'xls') {
      return { ok: true, text: await xlsxToText(new Uint8Array(await file.arrayBuffer())) }
    }
    if (ext === 'pdf') {
      const ready = await relay<{ available?: boolean; reason?: string }>('/docs/extract/ready')
      if (!ready?.available) {
        return { ok: false, error: ready?.reason ?? 'docs-extract-unavailable' }
      }
      const res = await relay<{ ok?: boolean; text?: string; error?: string }>('/docs/extract', {
        bytesBase64: await fileToBase64(file),
        name: file.name,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'extract-failed' }
      return { ok: true, text: res.text ?? '' }
    }
    return { ok: false, error: `不支持解析 .${ext} 附件` }
  } catch (e) {
    return { ok: false, error: `解析失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ────────────────────────────────────────────────────────────
// window.desktop
// ────────────────────────────────────────────────────────────

const menuListeners = new Set<(command: MenuCommand, payload?: string) => void>()
const openListeners = new Set<(result: Exclude<OpenDocxResult, null>) => void>()
const renamedListeners = new Set<(paths: { oldPath: string; newPath: string }) => void>()
const closeCheckListeners = new Set<() => void>()
const closeSaveRequestListeners = new Set<() => void>()
const teardownListeners = new Set<() => void>()

let blankConsumed = false

const desktop: DesktopApi = {
  getLanguage: async () => readLang(),
  onLanguageChanged: (handler) => {
    window.addEventListener('storage', (e) => {
      if (e.key === LANG_KEY) handler(readLang())
    })
    return () => window.removeEventListener('storage', handler as never)
  },

  getTheme: async () => readTheme(),
  onThemeChanged: (handler) => {
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_KEY) handler(readTheme())
    })
    return () => window.removeEventListener('storage', handler as never)
  },

  getAutoSaveDefault: async (): Promise<AutoSaveDefault> => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: () => () => {},
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: () => () => {},

  onChromePressed: () => () => {},

  openDocx: async () => {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [handle] = await window.showOpenFilePicker({ types: DOCX_PICKER_TYPES })
        return await loadHandle(handle)
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return null
        /* fall through to the input fallback */
      }
    }
    const file = await pickViaInput('.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    if (!file) return null
    const data = await file.arrayBuffer()
    const path = newPath(file.name)
    return await resultFromBytes(path, file.name, data)
  },

  openDocxPath: async (path) => {
    const opened = await openRecordBytes(path)
    if (opened) {
      const rec = await loadRecord(path)
      if (rec) await persistRecord(path, { ...rec, accessedAt: Date.now() })
      return await resultFromBytes(path, opened.name, opened.data, false)
    }
    if (!isAbsFsPath(path)) return null
    const remote = await bytesFromRemote(`path:${path}`)
    if (!remote) return null
    return await resultFromBytes(path, remote.name, remote.data)
  },

  openDocxDecrypt: async (path, password) => {
    const ready = await relay<{ available?: boolean; reason?: string }>('/docs/crypto/ready')
    if (!ready?.available) {
      return { ok: false as const, reason: 'unsupported' as const, error: ready?.reason ?? 'docs-crypto-unavailable' }
    }
    let opened = await openRecordBytes(path)
    if (!opened && isAbsFsPath(path)) {
      const remote = await bytesFromRemote(`path:${path}`)
      if (remote) {
        opened = { name: remote.name, data: remote.data }
        await persistOpenedBytes(path, remote.name, remote.data)
      }
    }
    if (!opened) return { ok: false as const, reason: 'error' as const, error: 'file-not-found' }
    const decrypted = await decryptViaRelay(opened.data, password)
    if (!decrypted.ok) {
      return { ok: false as const, reason: decrypted.reason, error: decrypted.error }
    }
    diskPasswords.set(path, password)
    return {
      ok: true as const,
      result: {
        path,
        name: opened.name,
        data: decrypted.data,
        hash: await sha256Hex(opened.data),
        encrypted: true,
      },
    }
  },

  setDocPassword: async (filePath, password) => {
    const intent = { password, revision: nextIntentRevision++ }
    if (filePath) desiredPasswords.set(filePath, intent)
    else pendingNewPassword = intent
    return { ok: true }
  },

  docPasswordIntentRevision: async () => nextIntentRevision - 1,

  discardDocPasswordIntents: async (throughRevision) => {
    const cutoff = throughRevision ?? Number.MAX_SAFE_INTEGER
    for (const [path, intent] of desiredPasswords) {
      if (intent.revision <= cutoff) desiredPasswords.delete(path)
    }
    if (pendingNewPassword && pendingNewPassword.revision <= cutoff) pendingNewPassword = null
    return { ok: true }
  },

  consumePendingOpenDocx: async () => {
    return await consumePendingOpenDocxImpl()
  },

  consumeNewBlankDoc: async () => {
    if (blankConsumed) return false
    blankConsumed = true
    return true
  },

  consumeAiDocContent: async () => null,
  createDocument: async () => ({
    ok: false,
    error: '网页版暂不支持 create_document；请在本页直接编辑后显式保存',
  }),

  onOpenDocx: (handler) => {
    openListeners.add(handler)
    return () => openListeners.delete(handler)
  },

  onRenamedDocx: (handler) => {
    renamedListeners.add(handler)
    return () => renamedListeners.delete(handler)
  },

  saveDocx: async (path, data) => {
    const prepared = await prepareSaveBytes(path, data)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    data = prepared.data
    if (isAbsFsPath(path)) {
      const written = await writeAbsFile(path, data)
      if (!written.ok) return { ok: false, error: written.error }
      await persistOpenedBytes(path, fileName(path), data)
      return { ok: true }
    }
    const rec = await loadRecord(path)
    if (rec?.kind === 'fs' && rec.handle) {
      try {
        if ((await rec.handle.queryPermission!({ mode: 'readwrite' })) !== 'granted') {
          await rec.handle.requestPermission!({ mode: 'readwrite' })
        }
        const writable = await rec.handle.createWritable()
        await writable.write(data)
        await writable.close()
        await persistRecord(path, { ...rec, mtime: Date.now(), accessedAt: Date.now() })
        return { ok: true }
      } catch {
        /* permission lost — fall back to download */
      }
    }
    downloadBytes(data, rec?.name ?? fileName(path))
    return { ok: true }
  },

  writeRecoveryCopy: async (path, data) => {
    try {
      await idbPut(STORE_RECOVERY, path, data)
    } catch {
      /* quota — recovery copies are best-effort */
    }
    return { ok: true }
  },

  onTeardown: (handler) => {
    teardownListeners.add(handler)
    return () => teardownListeners.delete(handler)
  },

  respellKick: async () => {},

  saveDocxAs: async (defaultName, data, sourcePath) => {
    const prepared = await prepareSaveBytes(sourcePath ?? null, data)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    data = prepared.data
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
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
        await writable.write(data)
        await writable.close()
        const path = newPath(defaultName)
        await persistRecord(path, {
          name: defaultName,
          kind: 'fs',
          handle,
          mtime: Date.now(),
          accessedAt: Date.now(),
        })
        return { ok: true, path }
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return { ok: false, error: '已取消' }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    downloadBytes(data, defaultName)
    return { ok: true, path: defaultName }
  },

  saveDocxNew: async (defaultName, data) => {
    const prepared = await prepareSaveBytes(null, data)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    return await desktop.saveDocxAs(defaultName, prepared.data)
  },

  getRecentFiles: async () => {
    // in-memory registry first: files opened this session are recent even if
    // the IndexedDB persist failed (e.g. a non-cloneable handle)
    const mem = [...fileRegistry.entries()].map(([path, rec]) => ({
      path,
      accessedAt: rec.accessedAt ?? 0,
    }))
    const keys = await idbAllKeys(STORE_HANDLES)
    const persisted: Array<{ path: string; accessedAt: number }> = []
    for (const key of keys) {
      if (fileRegistry.has(key)) continue
      const rec = await idbGet<WebFileRecord>(STORE_HANDLES, key)
      if (rec) persisted.push({ path: key, accessedAt: rec.accessedAt ?? 0 })
    }
    return [...mem, ...persisted]
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .map((r) => r.path)
  },

  pickImage: async () => {
    const file = await pickViaInput('image/png,image/jpeg,image/gif')
    if (!file) return null
    const mime = file.type as PickImageResult['mime']
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif') return null
    return { base64: await fileToBase64(file), mime, name: file.name }
  },

  fontMetrics: async () => null,

  getAiSettings: async () => readAiSettings(),
  setAiSettings: async (settings) => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings))
  },

  print: async () => {
    const ready = await relay<{ available?: boolean; reason?: string }>('/print/ready')
    if (!ready?.available) return { ok: false, error: ready?.reason ?? 'print-service-unavailable' }
    window.print()
    return { ok: true }
  },

  exportPdf: async (defaultName, pageWidthTwips, pageHeightTwips, outPath, scale) => {
    const stem = String(defaultName || 'document').replace(/\.[^.]+$/, '')
    const dest =
      typeof outPath === 'string' && outPath.startsWith('/')
        ? outPath
        : `/tmp/genoffice-web-print/${stem}.pdf`
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${stem}</title></head><body>${document.body?.innerHTML ?? '<p></p>'}</body></html>`
    return runPrintJob({ app: 'docs', dest, html, pageWidthTwips, pageHeightTwips, scale })
  },

  exportHtml: async (defaultName, html) => {
    const name = defaultName.endsWith('.html') ? defaultName : `${defaultName}.html`
    downloadBytes(new TextEncoder().encode(html).buffer, name)
    return { ok: true, path: name }
  },

  printPdfBuffer: async (pageWidthTwips, pageHeightTwips, scale) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${document.body?.innerHTML ?? '<p></p>'}</body></html>`
    const printed = await runPrintJob({
      app: 'docs',
      html,
      pageWidthTwips,
      pageHeightTwips,
      scale,
      returnBytes: true,
    })
    if (!printed.ok || !printed.base64) return { ok: false, error: printed.error ?? 'print-failed' }
    return { ok: true, base64: printed.base64 }
  },

  saveMergedPdf: async (defaultName, base64Parts, outPath) => {
    const dest =
      typeof outPath === 'string' && outPath.startsWith('/')
        ? outPath
        : `/tmp/genoffice-web-print/${String(defaultName || 'document').replace(/\.[^.]+$/, '')}.pdf`
    if (!Array.isArray(base64Parts) || base64Parts.length === 0) return { ok: false, error: 'empty merge' }
    const printed = await runPrintJob(
      base64Parts.length === 1
        ? { app: 'docs', dest, pdfBase64: base64Parts[0] }
        : { app: 'docs', dest, pdfsBase64: base64Parts },
    )
    return printed.ok ? { ok: true, path: printed.path } : { ok: false, error: printed.error ?? 'merge-failed' }
  },

  aiChat: async (request: AiChatRequest): Promise<AiChatResponse> => {
    const { settings, system, user } = request
    const provider = settings.provider
    const config = settings.providers?.[provider]
    if (!config?.apiKey) {
      return {
        ok: false,
        error:
          provider === 'genspark'
            ? '网页版需要配置自己的模型 API Key（面板右上角 ⚙），Genspark 登录仅在桌面版可用'
            : `未配置 ${provider} 的 API Key（面板右上角 ⚙ 设置）`,
      }
    }
    if (!config.model) return { ok: false, error: '未配置模型（面板右上角 ⚙ 设置）' }
    return await chatForProvider(provider, config, system, user)
  },

  aiStream: async (request) => {
    void runAiStream(request)
  },

  aiStreamCancel: async (requestId) => {
    activeStreams.get(requestId)?.abort()
  },

  aiGskStatus: async (): Promise<GenSparkAccountStatus> => ({ loggedIn: false }),

  aiGskLogin: async () => {
    // Genspark login needs a server-side session; best effort: open the site
    window.open('https://www.genspark.ai', '_blank', 'noopener')
  },

  webSearch: async (query, maxResults) => {
    const ready = await relay<{ search?: { available?: boolean; reason?: string } }>('/providers/ready')
    if (!ready?.search?.available) {
      return { results: [], method: 'error', error: ready?.search?.reason ?? 'search-unconfigured' }
    }
    const res = await relay<{
      results: Array<{ title: string; url: string; snippet: string }>
      answer?: string
      method: string
      error?: string
    }>('/search/web', { query, maxResults: maxResults ?? 5 })
    if (res) return res
    return {
      results: [],
      method: 'error',
      error: '联网搜索需要本地中继服务（npm run web），或已在桌面版中配置 Serper API Key',
    }
  },

  imageSearch: async (query, maxResults) => {
    const ready = await relay<{ imageSearch?: { available?: boolean; reason?: string } }>('/providers/ready')
    if (!ready?.imageSearch?.available) {
      return { images: [], method: 'error', error: ready?.imageSearch?.reason ?? 'image-search-unconfigured' }
    }
    const res = await relay<{
      images: Array<{
        title: string
        imageUrl: string
        sourceUrl: string
        source: string
        width?: number
        height?: number
      }>
      method: string
      error?: string
    }>('/search/image', { query, maxResults: maxResults ?? 6 })
    if (res) return res
    return {
      images: [],
      method: 'error',
      error: '图片搜索需要本地中继服务（npm run web）',
    }
  },

  fetchImage: async (url) => {
    return await relay<{ base64: string; mime: string }>('/fetch-image', { url })
  },

  aiGenerateImage: async (op) => {
    const ready = await relay<{ generate?: { available?: boolean; reason?: string } }>('/providers/ready')
    if (!ready?.generate?.available) {
      return { error: ready?.generate?.reason ?? 'generate-provider-unconfigured' }
    }
    const res = await relay<{ url?: string; error?: string }>(
      '/generate-image',
      { prompt: op.prompt, aspectRatio: op.aspectRatio, dest: (op as { dest?: string }).dest },
      { timeout: 600_000 } as RequestInit,
    )
    return res ?? { error: '图片生成需要本地中继服务' }
  },

  pickAttachments: async (): Promise<AttachmentAddResult | null> => {
    const input = hiddenInput('*')
    const files = await new Promise<File[] | null>((resolve) => {
      input.onchange = () => {
        const picked = input.files ? [...input.files] : null
        input.remove()
        resolve(picked)
      }
      input.oncancel = () => {
        input.remove()
        resolve(null)
      }
      input.click()
    })
    if (!files || files.length === 0) return null
    return buildAddResult(files)
  },

  addAttachmentPaths: async (paths): Promise<AttachmentAddResult> => {
    const accepted: AttachmentMeta[] = []
    const rejected: string[] = []
    for (const path of paths) {
      const rec = await loadRecord(path)
      if (rec) {
        accepted.push({ path, name: rec.name, ext: extOf(rec.name), sizeBytes: 0 })
      } else {
        rejected.push(`找不到附件: ${path}`)
      }
    }
    return { accepted, rejected }
  },

  addPastedImage: async (data, ext): Promise<AttachmentAddResult> => {
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    const file = new File([data], `pasted-${Date.now()}.${ext}`, { type: mime })
    const meta = registerFileAsAttachment(file)
    if ('error' in meta) return { accepted: [], rejected: [meta.error] }
    return { accepted: [meta], rejected: [] }
  },

  copyImageToClipboard: async (dataUrl) => {
    try {
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      return true
    } catch {
      return false
    }
  },

  readAttachment: async (path, offset, maxChars): Promise<AttachmentReadResult> => {
    const rec = await loadRecord(path)
    const file = rec
      ? rec.handle
        ? await rec.handle.getFile()
        : rec.bytes
          ? new File([rec.bytes], rec.name)
          : null
      : transientFiles.get(path) ?? null
    if (!file) return { ok: false, error: '附件不存在或已失效' }
    const parsed = await extractAttachmentText(file)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const text = parsed.text ?? ''
    return {
      ok: true,
      name: file.name,
      totalChars: text.length,
      offset,
      text: text.slice(offset, offset + maxChars),
    }
  },

  readAttachmentImage: async (path): Promise<AttachmentImageResult> => {
    const rec = await loadRecord(path)
    const file = rec
      ? rec.handle
        ? await rec.handle.getFile()
        : rec.bytes
          ? new File([rec.bytes], rec.name)
          : null
      : transientFiles.get(path) ?? null
    if (!file) return { ok: false, error: '附件不存在或已失效' }
    if (file.size > 5 * 1024 * 1024) return { ok: false, error: '图片超过 5MB，无法作为多模态输入' }
    return { ok: true, base64: await fileToBase64(file), mime: file.type }
  },

  getPathForFile: (file) => {
    const path = newPath(file.name)
    transientFiles.set(path, file)
    return path
  },

  openNewTab: async (openPath) => {
    const url = new URL(location.href)
    if (openPath) url.searchParams.set('open', openPath)
    window.open(url.toString(), '_blank', 'noopener')
  },

  listDocsTabs: async (): Promise<DocsTabInfo[]> => [
    { id: 'web-tab', title: document.title, focused: true },
  ],

  focusDocsTab: async () => {},

  onAiStream: (handler) => {
    streamListeners.add(handler)
    return () => streamListeners.delete(handler)
  },

  onMenuCommand: (handler) => {
    menuListeners.add(handler)
    return () => menuListeners.delete(handler)
  },

  onCloseCheck: (handler) => {
    closeCheckListeners.add(handler)
    return () => closeCheckListeners.delete(handler)
  },

  reportCloseCheck: () => {},

  onCloseSaveRequest: (handler) => {
    closeSaveRequestListeners.add(handler)
    return () => closeSaveRequestListeners.delete(handler)
  },

  reportCloseSaveResult: () => {},

  reportViewMenuState: () => {},
}

// ────────────────────────────────────────────────────────────
// window.projectApi (minimal IndexedDB-backed implementation)
// ────────────────────────────────────────────────────────────

const DEFAULT_PROJECT_ID = 'web-default'
const DEFAULT_PROJECT_NAME = '网页版项目'

function chatKey(projectId: string, chatId: string): string {
  return `${projectId}:${chatId}`
}

function stableChatId(filePath: string | null, tempChatId?: string): string {
  if (tempChatId) return tempChatId
  return filePath ? `file-${filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)}` : 'default'
}

const projectApi: ProjectApi = {
  resolveChat: async ({ filePath, tempChatId }) => ({
    projectId: DEFAULT_PROJECT_ID,
    chatId: stableChatId(filePath, tempChatId),
  }),

  appendChat: async ({ projectId, chatId, role, text, tools, attachments }) => {
    const key = chatKey(projectId, chatId)
    const existing = (await idbGet<ChatMessage[]>(STORE_CHATS, key)) ?? []
    existing.push({
      seq: existing.length,
      ts: new Date().toISOString(),
      role,
      text,
      tools,
      attachments,
    })
    await idbPut(STORE_CHATS, key, existing)
  },

  loadChat: async ({ projectId, chatId, limit }) => {
    const existing = (await idbGet<ChatMessage[]>(STORE_CHATS, chatKey(projectId, chatId))) ?? []
    return limit ? existing.slice(-limit) : existing
  },

  rebindChat: async ({ projectId, tempChatId, newChatId, newFilePath }) => {
    const oldKey = chatKey(projectId, tempChatId)
    const existing = await idbGet<ChatMessage[]>(STORE_CHATS, oldKey)
    if (existing) {
      const newKey = chatKey(projectId, newChatId ?? stableChatId(newFilePath ?? null))
      await idbPut(STORE_CHATS, newKey, existing)
      if (newKey !== oldKey) await idbDelete(STORE_CHATS, oldKey)
    }
    return { projectId, chatId: newChatId ?? stableChatId(newFilePath ?? null) }
  },

  listProjects: async (): Promise<ProjectSummary[]> => [
    {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
      fileCount: 0,
      lastActiveAt: new Date().toISOString(),
      isDefault: true,
    },
  ],

  createProject: async ({ name }) => ({
    id: DEFAULT_PROJECT_ID,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fileCount: 0,
    lastActiveAt: new Date().toISOString(),
    isDefault: true,
  }),

  renameProject: async () => {},
  deleteProject: async () => {},
  moveFile: async () => {},

  getTimeline: async (): Promise<TimelineEntry[]> => [],
}

// ────────────────────────────────────────────────────────────
// URL-driven file opening
//
// A document can be opened by URL in several forms:
//   /docs/?open=<target>            query param (openNewTab / home screen)
//   /docs/?file=<target>            alias
//   /docs/f/<base64url(target)>     RESTful path form (deep links)
// where <target> is one of:
//   /webdoc/<id>/<name>             synthetic id → local IndexedDB handle/bytes
//   https://host/file.docx          remote file → relay proxy (CORS-free)
//   data:application/octet-stream;base64,…   inline bytes
//   server:<relpath>                file on the relay host (GENOFFICE_WEB_FILES_ROOT)
// ────────────────────────────────────────────────────────────

function appForExt(ext: string): string | null {
  switch (ext) {
    case 'docx':
      return 'docs'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'xlsx':
      return 'sheets'
    case 'pptx':
      return 'slides'
    case 'pdf':
      return 'pdf'
    default:
      return null
  }
}

function parseOpenTarget(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v) return v
  }
  // RESTful path form: /docs/f/<base64url>
  const m = location.pathname.match(/\/(?:docs|markdown)\/f\/([A-Za-z0-9_-]+)\/?$/)
  if (m) {
    try {
      const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
      return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))
    } catch {
      /* malformed base64url — treat as no target */
    }
  }
  return null
}

// Captured before control.ts / boot effects rewrite the address bar.
const INITIAL_OPEN_TARGET = parseOpenTarget()
let pendingOpenConsumed = false

/** strip the open/file query params (and /f/ path) from the address bar */
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
  const isPath = target.startsWith('path:')
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
    if (!isHttp && !isServer && !isInject && !isPath) return null
    const endpoint = isHttp
      ? `fetch-file?url=${encodeURIComponent(target)}`
      : isServer
        ? `files?path=${encodeURIComponent(target.slice('server:'.length))}`
        : isInject
          ? `inject/${encodeURIComponent(target.slice('inject:'.length))}`
          : `file?path=${encodeURIComponent(target.slice('path:'.length))}`
    const resp = await fetch(`${RELAY_BASE}/${endpoint}`)
    if (!resp.ok) {
      if (isPath) throw new Error(`load-error: HTTP ${resp.status}`)
      return null
    }
    const data = (await resp.json()) as {
      ok: boolean
      base64?: string
      name?: string
      error?: string
      mtimeMs?: number | null
      fileRevision?: string | null
    }
    if (!data.ok || !data.base64) {
      if (isPath) throw new Error(`load-error: ${data.error ?? 'empty result for path target'}`)
      return null
    }
    if (isPath) bindLoadMeta({ mtimeMs: data.mtimeMs, fileRevision: data.fileRevision })
    const bin = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
    return { data: bin.buffer as ArrayBuffer, name: data.name ?? 'remote-file' }
  } catch (error) {
    if (isPath || String(error).includes('load-error:')) throw error
    return null
  }
}

async function openTarget(target: string): Promise<OpenDocxResult> {
  // synthetic id → local file (handle/bytes in IndexedDB)
  if (target.startsWith('/webdoc/')) {
    return await desktop.openDocxPath(target)
  }
  // remote / data: / server: → pull bytes through the relay and open as a
  // local (bytes) document. path: keeps the original filesystem path so
  // decrypt/save write back to the same file.
  const remote = await bytesFromRemote(target)
  if (!remote) {
    if (target.startsWith('path:')) throw new Error('load-error: empty result for path target')
    return null
  }
  const pathHint = target.startsWith('path:') ? target.slice('path:'.length) : target
  const looksDocx =
    remote.name.toLowerCase().endsWith('.docx') || pathHint.toLowerCase().endsWith('.docx')
  if (!looksDocx) return null
  const path = target.startsWith('path:') && isAbsFsPath(pathHint)
    ? pathHint
    : newPath(remote.name.toLowerCase().endsWith('.docx') ? remote.name : pathHint.split(/[\\/]/).pop() ?? remote.name)
  return await resultFromBytes(path, remote.name, remote.data)
}

async function consumePendingOpenDocxImpl(): Promise<OpenDocxResult> {
  if (pendingOpenConsumed) return null
  pendingOpenConsumed = true
  const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
  if (!target) return null
  clearOpenTarget()
  const opened = await openTarget(target)
  if (!opened && target.startsWith('path:')) {
    throw new Error('load-error: empty result for path target')
  }
  return opened
}

// ────────────────────────────────────────────────────────────
// Drag & drop: drop a local file onto the page to open it
// ────────────────────────────────────────────────────────────

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
    // the AI panel handles its own file drops (attachments)
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
      const app = appForExt(ext)
      if (!app) {
        // eslint-disable-next-line no-alert
        alert(`网页版暂不支持打开 .${ext} 文件`)
        return
      }
      const path = newPath(file.name)
      if (item && typeof (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle === 'function') {
        const handle = await (item as DataTransferItem & { getAsFileSystemHandle: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle()
        if (handle?.kind === 'file') {
          await persistRecord(path, {
            name: file.name,
            kind: 'fs',
            handle,
            mtime: file.lastModified,
            accessedAt: Date.now(),
          })
          window.open(`/${app}/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
          return
        }
      }
      const data = await file.arrayBuffer()
      await idbPut(STORE_HANDLES, path, {
        name: file.name,
        kind: 'bytes',
        bytes: data,
        mtime: file.lastModified,
        accessedAt: Date.now(),
      })
      window.open(`/${app}/?open=${encodeURIComponent(path)}`, '_blank', 'noopener')
      return
    } catch {
      /* fall through — user can use the open dialog instead */
    }
  })
}

// ────────────────────────────────────────────────────────────
// Install
// ────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.desktop = desktop
  window.projectApi = projectApi
  installFileDrop()
}

/**
 * GenOffice PDF — Web bridge (genoffice-dsh-office, web build only).
 *
 * Stand-in for the Electron preload bridge (`window.pdfApi`) that lets the
 * *unmodified* pdf renderer run in a plain browser tab:
 *
 *   - open via URL `/pdf/?open=path:<abs>` → relay `/api/file` bytes
 *     (kept in the web session; pdf.js renders in-process as on desktop)
 *   - save → the desktop save pipeline's pdf-lib merge (web-pdf-save.ts,
 *     ported from main/save-pdf.ts) + text/image edits through PDFium
 *     wasm (web-text-edit.ts / web-image-edit.ts) — applied in memory;
 *     the disk write happens only through the control-plane export (BR-008)
 *   - generateImage / analyzeMedia → localhost relay (no browser net egress)
 *   - theme / language / AI settings → localStorage
 *
 * This file is only included by the web build (vite.web.config.ts); the
 * desktop build never sees it.
 */
import type { AiSettings, AiStreamChunk } from '@genoffice/ai-provider'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type {
  PageImageRef,
  PagePreviewRequest,
  PdfApi,
  SavePdfRequest,
  SavePdfResult,
  TextEditValidation,
  UiTheme,
} from '../shared/ipc'
import { DEFAULT_AI_PANEL_PREFS } from '@genoffice/ui'
import { applySaveRequest, verifyContentEdits } from './web-pdf-save'
import {
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  setPageSizeBytes,
  splitPagesBytes,
} from '../shared/page-bytes'
import { validateTextEdits as validateTextEditsImpl } from './web-text-edit'
import { listEditFonts as listEditFontsImpl, canDrawText as canDrawTextImpl } from './web-text-edit'
import { PDFDocument } from 'pdf-lib'
import type { ConvertOfficeResult, PdfConvertFormat } from '../shared/ipc'
import { requestConvertCancel, runConvertInWorker } from './web-convert-office'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    __genofficeExportBytes?: () => Promise<{ bytes: Uint8Array; name: string } | null>
  }
}

window.__GENOFFICE_WEB__ = true

// ── settings (localStorage) ─────────────────────────────────────────────

const LANG_KEY = 'genoffice-web-lang'
const THEME_KEY = 'genoffice-web-theme'
const AI_SETTINGS_KEY = 'genoffice-web-ai-settings'

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
    if (raw) return JSON.parse(raw) as AiSettings
  } catch {
    /* fall through to defaults */
  }
  return defaultAiSettings()
}

// ── web session: the opened file's bytes ────────────────────────────────

interface WebPdfState {
  path: string
  bytes: Uint8Array
  name: string
  mtimeMs?: number
  fileRevision?: string
}

let opened: WebPdfState | null = null

async function blankPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([595.28, 841.89])
  return doc.save()
}

const RELAY_BASE = '/api'

async function relay<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
  try {
    const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) {
      init.method = 'POST'
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const resp = await fetch(`${RELAY_BASE}${path}`, init)
    if (!resp.ok) return null
    return (await resp.json()) as T
  } catch {
    return null
  }
}


const DB_NAME = 'genoffice-web'
const DB_VERSION = 1
const STORE_HANDLES = 'handles'

interface WebFileRecord {
  name: string
  kind: 'fs' | 'bytes'
  handle?: FileSystemFileHandle
  bytes?: ArrayBuffer
  mtime: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES)
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

async function bytesFromWebdoc(path: string): Promise<{ bytes: Uint8Array; name: string }> {
  const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
  if (!rec) throw new Error('load-error: missing browser file record')
  if (rec.kind === 'fs' && rec.handle) {
    const file = await rec.handle.getFile()
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
  }
  if (rec.bytes) {
    const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes)
    return { bytes, name: rec.name }
  }
  throw new Error('load-error: empty browser file record')
}

function parseOpenTarget(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v) return v
  }
  return null
}

const INITIAL_OPEN_TARGET = parseOpenTarget()

function openPathFromUrl(): string | null {
  const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
  if (target?.startsWith('path:')) return target.slice('path:'.length)
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
  if (changed) history.replaceState(null, '', url)
}

async function fetchPathBytes(path: string): Promise<{
  bytes: Uint8Array
  name: string
  mtimeMs?: number
  fileRevision?: string
}> {
  const res = await relay<{
    ok: boolean
    base64?: string
    name?: string
    error?: string
    mtimeMs?: number
    fileRevision?: string
  }>(`/file?path=${encodeURIComponent(path)}`)
  if (!res?.ok || !res.base64) throw new Error(`load-error: ${res?.error ?? 'empty result for path target'}`)
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  return {
    bytes: bin,
    name: res.name ?? path.split('/').pop() ?? 'document.pdf',
    mtimeMs: res.mtimeMs,
    fileRevision: res.fileRevision,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(0, i) : path
}

async function writeAbsPath(
  path: string,
  bytes: Uint8Array,
  expected?: { expectedMtimeMs?: number; expectedRevision?: string },
): Promise<{ mtimeMs?: number }> {
  const res = await relay<{ ok: boolean; error?: string; mtimeMs?: number }>(
    '/file',
    { path, base64: bytesToBase64(bytes), ...expected },
  )
  if (!res?.ok) throw new Error(res?.error ?? 'write failed')
  return { mtimeMs: res.mtimeMs }
}

async function writeNewSibling(sourcePath: string, suggestedName: string, bytes: Uint8Array): Promise<string> {
  const dir = dirOf(sourcePath)
  const raw = (suggestedName || 'output.bin').replace(/[/\\]/g, '_')
  const dot = raw.lastIndexOf('.')
  const ext = dot >= 0 ? raw.slice(dot) : ''
  const stem = (dot >= 0 ? raw.slice(0, dot) : raw) || 'output'
  let lastError = 'could not allocate output path'
  for (let i = 0; i < 20; i++) {
    const target = `${dir}/${stem}${i === 0 ? '' : `-${i + 1}`}${ext}`
    try {
      await writeAbsPath(target, bytes)
      return target
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (lastError !== 'conflict') throw error
    }
  }
  throw new Error(lastError)
}

async function writeNewPdf(sourcePath: string, suggestedName: string, bytes: Uint8Array): Promise<string> {
  const name = suggestedName.toLowerCase().endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`
  return writeNewSibling(sourcePath, name, bytes)
}

async function rewriteOpened(next: Uint8Array): Promise<void> {
  if (!opened) throw new Error('no file open')
  if (opened.path.startsWith('/webdoc/')) {
    opened = { ...opened, bytes: next }
    return
  }
  const written = await writeAbsPath(opened.path, next, {
    expectedRevision: opened.fileRevision,
    expectedMtimeMs: opened.mtimeMs,
  })
  opened = { ...opened, bytes: next, mtimeMs: written.mtimeMs, fileRevision: undefined }
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

function requireOpened(): WebPdfState | { ok: false; error: string } {
  if (!opened) return { ok: false, error: 'no file open' }
  return opened
}

/** control-mode write-back payload (BR-008): CURRENT merged bytes. */
export async function exportPdfBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!opened) return null
  return { bytes: opened.bytes, name: opened.name }
}

window.__genofficeExportBytes = exportPdfBytes

// ── window.pdfApi ───────────────────────────────────────────────────────

const aiStreamListeners = new Set<(chunk: AiStreamChunk) => void>()
const closeSaveListeners = new Set<() => void>()
const saveAsListeners = new Set<(targetPath: string) => void>()
const saveAsFlowListeners = new Set<(inFlight: boolean) => void>()
const themeListeners = new Set<(theme: UiTheme) => void>()

const pdfApi: PdfApi = {
  consumePending: async () => {
    const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
    if (target?.startsWith('path:')) {
      const abs = target.slice('path:'.length)
      const fetched = await fetchPathBytes(abs)
      opened = {
        path: abs,
        bytes: fetched.bytes,
        name: fetched.name,
        mtimeMs: fetched.mtimeMs,
        fileRevision: fetched.fileRevision,
      }
      clearOpenTarget()
      return abs
    }
    if (target?.startsWith('/webdoc/')) {
      const fetched = await bytesFromWebdoc(target)
      opened = { path: target, bytes: fetched.bytes, name: fetched.name }
      clearOpenTarget()
      return target
    }
    if (!target) {
      const bytes = await blankPdfBytes()
      const path = `/webdoc/${crypto.randomUUID()}/untitled.pdf`
      opened = { path, bytes, name: 'untitled.pdf' }
      return path
    }
    return null
  },

  readFile: async (path) => {
    if (opened?.path === path) {
      return opened.bytes.buffer.slice(
        opened.bytes.byteOffset,
        opened.bytes.byteOffset + opened.bytes.byteLength,
      ) as ArrayBuffer
    }
    const fetched = await fetchPathBytes(path)
    if (!fetched) throw new Error('pdf: file not readable')
    opened = {
      path,
      bytes: fetched.bytes,
      name: fetched.name,
      mtimeMs: fetched.mtimeMs,
      fileRevision: fetched.fileRevision,
    }
    return fetched.bytes.buffer.slice(
      fetched.bytes.byteOffset,
      fetched.bytes.byteOffset + fetched.bytes.byteLength,
    ) as ArrayBuffer
  },

  save: async (request: SavePdfRequest): Promise<SavePdfResult> => {
    if (!opened) return { ok: false, error: 'no file open' }
    try {
      const { bytes, ...skips } = await applySaveRequest(opened.bytes, request)
      // Read-back check before the bytes become the session document, mirroring the
      // desktop savePdfToPath order: a verify failure keeps the previous bytes and the
      // pending edits rather than reporting a save that dropped content.
      await verifyContentEdits(bytes, request, skips)
      opened = { ...opened, bytes }
      return {
        ok: true,
        ...(skips.skippedTextEdits.length > 0 ? { skippedTextEdits: skips.skippedTextEdits } : {}),
        ...(skips.skippedTextInserts.length > 0
          ? { skippedTextInserts: skips.skippedTextInserts }
          : {}),
        ...(skips.skippedImageEdits.length > 0
          ? { skippedImageEdits: skips.skippedImageEdits }
          : {}),
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  validateTextEdits: async (request) => {
    if (!opened)
      return request.edits.map((e) => ({
        pageIndex: e.pageIndex,
        oldText: e.oldText,
        reason: 'no file open',
      }))
    // dry-run MATCH validation (mirror of the desktop main process) — not the
    // apply-then-verify read-back, which would report the replacement missing
    // from unedited bytes
    return validateTextEditsImpl(opened.bytes, request.edits)
  },

  listEditFonts: async () => listEditFontsImpl(),

  listPageImages: async (): Promise<PageImageRef[]> => {
    if (!opened) return []
    const { listPageImages } = await import('./web-image-edit')
    return listPageImages(opened.bytes)
  },

  pageImagePng: async (request) => {
    if (!opened) return null
    const { renderImagePng } = await import('./web-image-edit')
    return renderImagePng(opened.bytes, request.pageIndex, request.rect)
  },
  pagePreviewPng: async (request: PagePreviewRequest) => {
    if (!opened) return null
    const { renderPagePreviewPng } = await import('./web-image-edit')
    return renderPagePreviewPng(opened.bytes, request)
  },

  extractPages: async (request) => {
    const session = requireOpened()
    if ('error' in session) return session
    const pages = request?.pages
    if (!Array.isArray(pages) || pages.length === 0) {
      return { ok: false as const, error: 'empty page selection' }
    }
    try {
      const src = await PDFDocument.load(session.bytes, { updateMetadata: false })
      const count = src.getPageCount()
      const valid = pages.filter((p) => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < count)
      if (valid.length === 0) return { ok: false as const, error: 'invalid page range' }
      const bytes = await extractPagesBytes(session.bytes, valid)
      const savedPath = await writeNewPdf(session.path, request.suggestedName, bytes)
      return { ok: true as const, savedPath }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  },

  insertPdf: async () => ({ ok: true, canceled: true }),

  exportImages: async () => ({ ok: true, canceled: true }),

  imageSearch: async (query, maxResults) => {
    const res = await relay<{
      images: Array<{
        title: string
        imageUrl: string
        sourceUrl: string
        width?: number
        height?: number
      }>
      method: string
      error?: string
    }>('/search/image', { query, maxResults: maxResults ?? 6 })
    if (res) {
      return {
        images: res.images.map((img) => ({ ...img, source: 'bing' })),
        method: res.method,
      }
    }
    return { images: [], method: 'error' }
  },

  fetchImage: async (url) => {
    return await relay<{ base64: string; mime: string }>('/fetch-image', { url })
  },

  generateImage: async (op) => {
    const res = await relay<{ url?: string; error?: string }>(
      '/generate-image',
      {
        prompt: op.prompt,
        aspectRatio: op.aspectRatio,
      },
      600_000,
    )
    if (!res) return { error: '图片生成需要本地中继服务（npm run web）且已登录 Genspark' }
    return res
  },

  autoRename: async () => ({ renamed: false }),
  isUntitled: async () => false,
  canDrawText: (text, font, bold, italic) => canDrawTextImpl(text, font, bold, italic),
  listStaticFormFills: async () => [],
  insertBlankPage: async (request) => {
    const session = requireOpened()
    if ('error' in session) return session
    try {
      const next = await insertBlankPageBytes(
        session.bytes,
        typeof request?.afterPageIndex === 'number' ? request.afterPageIndex : -1,
      )
      await rewriteOpened(next)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  },
  splitPdf: async () => ({ ok: true as const, canceled: true as const }),
  mergePdf: async () => ({ ok: true as const, canceled: true as const }),
  mergePages: async () => ({ ok: true as const, canceled: true as const }),
  replacePages: async () => ({ ok: true as const, canceled: true as const }),
  setPageSize: async (request) => {
    const session = requireOpened()
    if ('error' in session) return session
    const width = request?.width
    const height = request?.height
    if (!(width > 0) || !(height > 0)) return { ok: false as const, error: 'invalid page size' }
    try {
      const next = await setPageSizeBytes(session.bytes, width, height)
      await rewriteOpened(next)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  },
  splitPages: async (request) => {
    const session = requireOpened()
    if ('error' in session) return session
    const perPage = request?.perPage
    if (perPage !== 2 && perPage !== 4 && perPage !== 9) {
      return { ok: false as const, error: 'perPage must be 2, 4, or 9' }
    }
    try {
      const bytes = await splitPagesBytes(session.bytes, perPage)
      const savedPath = await writeNewPdf(session.path, request.suggestedName, bytes)
      return { ok: true as const, savedPath }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  },
  cropPages: async (request) => {
    const session = requireOpened()
    if ('error' in session) return session
    const pages = request?.pages
    const rect = request?.rect
    if (!Array.isArray(pages) || pages.length === 0) {
      return { ok: false as const, error: 'empty page selection' }
    }
    if (!rect || !(rect.r > rect.l) || !(rect.b > rect.t)) {
      return { ok: false as const, error: 'invalid crop rect' }
    }
    try {
      const src = await PDFDocument.load(session.bytes, { updateMetadata: false })
      const count = src.getPageCount()
      if (!pages.some((p) => typeof p === 'number' && p >= 0 && p < count)) {
        return { ok: false as const, error: 'invalid page range' }
      }
      const next = await cropPagesBytes(session.bytes, pages, rect)
      await rewriteOpened(next)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  },
  convertOffice: async (format: PdfConvertFormat): Promise<ConvertOfficeResult> => {
    const session = requireOpened()
    if ('error' in session) return { ok: false, error: session.error }
    if (format !== 'docx' && format !== 'pptx' && format !== 'xlsx') {
      return { ok: false, error: 'unsupported convert format' }
    }
    try {
      const converted = await runConvertInWorker(session.bytes, format)
      if (converted.canceled) return { ok: true, canceled: true }
      const stem = (session.name || 'document').replace(/\.pdf$/i, '') || 'document'
      const savedPath = await writeNewSibling(session.path, `${stem}.${format}`, converted.bytes)
      return {
        ok: true,
        savedPath,
        scannedDocument: converted.scannedDocument,
        warnings: converted.warnings,
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
  cancelConvertOffice: async () => {
    requestConvertCancel()
  },
  listSavedSignatures: async () => [],
  addSavedSignature: async () => [],
  removeSavedSignature: async () => [],
  getUsername: async () => '',
  onPrintRequest: () => () => {},
  onChromePressed: () => () => {},
  gskStatus: async () => ({ loggedIn: false }),

  setDirty: () => {},

  onCloseSaveRequest: (handler) => {
    closeSaveListeners.add(handler)
    return () => closeSaveListeners.delete(handler)
  },

  sendCloseSaveResult: () => {},

  onSaveAsRequest: (handler) => {
    saveAsListeners.add(handler)
    return () => saveAsListeners.delete(handler)
  },

  sendSaveAsResult: () => {},

  onSaveAsFlow: (handler) => {
    saveAsFlowListeners.add(handler)
    return () => saveAsFlowListeners.delete(handler)
  },

  getLanguage: async () => readLang(),
  onLanguageChanged: () => () => {},
  getTheme: async () => readTheme(),
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: () => () => {},
  onThemeChanged: (handler) => {
    themeListeners.add(handler)
    return () => themeListeners.delete(handler)
  },

  getAiSettings: async () => readAiSettings(),
  exportPdf: async (dest: string) => {
    const session = requireOpened()
    if ('error' in session) return { ok: false, error: session.error }
    if (typeof dest !== 'string' || dest.startsWith('/') === false) {
      return { ok: false, error: 'exportPdf needs an absolute dest' }
    }
    let binary = ''
    const bytes = session.bytes
    const step = 0x8000
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step))
    }
    const printed = await runPrintJob({ app: 'pdf', dest, pdfBase64: btoa(binary) })
    return printed.ok ? { ok: true, path: printed.path ?? dest } : { ok: false, error: printed.error ?? 'print-failed' }
  },
  ocrPage: async () => null,
  createDocument: async () => ({ ok: false, error: '网页版暂不支持 create_document' }),
  aiStream: async () => {},
  aiStreamCancel: async () => {},
  onAiStream: (handler) => {
    aiStreamListeners.add(handler)
    return () => aiStreamListeners.delete(handler)
  },
}

// ── install ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  ;(window as unknown as { pdfApi: PdfApi }).pdfApi = pdfApi
}

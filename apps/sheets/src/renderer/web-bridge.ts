/**
 * GenOffice Sheets — Web bridge (genoffice-dsh-office).
 *
 * Stand-in for the Electron preload bridge (`window.desktopApi` /
 * `window.projectApi`) that lets the *unmodified* sheets renderer run in a
 * plain browser tab:
 *
 *   - open via URL  `/sheets/?open=path:<abs>` → relay `/api/file` bytes →
 *     browser xlsx parse (web-xlsx.ts) → `WorkbookFile` (lazy model intact)
 *   - home `/webdoc/...` targets reuse the shared IndexedDB store (no sidecar spawn)
 *   - range/formula reads → in-memory parsed store (shared formulas + names/hidden/tables/filters/protection)
 *   - media/pivot reads → zip parts + gateway parsePivotDefinition (INV-003)
 *   - save → the renderer's edit journal applied to the ORIGINAL archive via
 *     the gateway's pure-JSZip pipeline (only touched entries change — BR-009)
 *   - theme / language / AI settings → localStorage
 *   - AI streaming: not wired in the browser (control mode hides the AI
 *     panel; non-control keeps desktop semantics where the provider exists —
 *     see Task 7 note: no docs-style AI-direct wiring in this bridge)
 *
 * This file is only included by the web build (vite.web.config.ts); the
 * desktop build never sees it.
 */
import { bindLoadMeta } from './control'
import type {
  AiChatRequest,
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  GenSparkAccountStatus,
} from '@genoffice/ai-provider'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { ProjectApi } from '@genoffice/project-store'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  DesktopApi,
  LocalImageResult,
  MenuAction,
  ScreenCaptureResult,
  ScreenSourcesResult,
  UiTheme,
  WorkbookExportPdfRequest,
  WorkbookExportPdfResult,
  WorkbookFile,
  WorkbookMediaResult,
  WorkbookPivotDefinition,
  WorkbookRangeResult,
  WorkbookRecalcResult,
  WorkbookSaveRequest,
  WorkbookSaveResult,
  AutoSaveDefault,
} from '../shared/desktop-api'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  applySaveRequest,
  buildFormulaResult,
  buildRangeResult,
  parseXlsxWorkbook,
  type ParsedWorkbook,
} from './web-xlsx'
import {
  bytesToBase64,
  readMediaPart,
  readPivotParts,
  sniffImageMediaType,
} from './web-xlsx-media'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    __genofficeExportBytes?: () => Promise<{ bytes: Uint8Array; name: string } | null>
    __genofficeWorkbookFile?: () => WorkbookFile | null
    showOpenFilePicker?: (options?: unknown) => Promise<unknown[]>
    showSaveFilePicker?: (options?: unknown) => Promise<unknown>
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

// ── opened workbook state ───────────────────────────────────────────────

interface WebWorkbookState {
  path: string
  name: string
  originalBytes: Uint8Array
  latestBytes: Uint8Array
  store: ParsedWorkbook
  file: WorkbookFile
  mtimeMs: number | null
  lastRead: number
}

let opened: WebWorkbookState | null = null
let blankConsumed = false

const DB_NAME = 'genoffice-web'
const DB_VERSION = 1
const STORE_HANDLES = 'handles'

interface WebFileRecord {
  name: string
  kind: 'fs' | 'bytes'
  handle?: FileSystemFileHandle
  bytes?: ArrayBuffer
  mtime: number
  accessedAt: number
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

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── relay helpers ───────────────────────────────────────────────────────

const RELAY_BASE = '/api'

async function relay<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const init: RequestInit = { signal: AbortSignal.timeout(60_000) }
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

/** URL open target (`?open=` / `?file=`), captured before the address bar is rewritten. */
function parseOpenTarget(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v) return v
  }
  return null
}

const INITIAL_OPEN_TARGET = parseOpenTarget()

async function fetchPathBytes(path: string): Promise<{ bytes: Uint8Array; name: string; mtimeMs: number | null }> {
  const res = await relay<{
    ok: boolean
    base64?: string
    name?: string
    mtimeMs?: number | null
    fileRevision?: string | null
    error?: string
  }>(
    `/file?path=${encodeURIComponent(path)}`,
  )
  if (!res?.ok || !res.base64) {
    throw new Error(`load-error: ${res?.error ?? 'empty result for path target'}`)
  }
  bindLoadMeta({ mtimeMs: res.mtimeMs, fileRevision: res.fileRevision })
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  return { bytes: bin, name: res.name ?? path.split('/').pop() ?? 'workbook.xlsx', mtimeMs: res.mtimeMs ?? null }
}

async function adoptWorkbook(
  path: string,
  name: string,
  bytes: Uint8Array,
  mtimeMs: number | null,
): Promise<WorkbookFile> {
  const parsed = await parseXlsxWorkbook(bytes, name)
  opened = {
    path,
    name,
    originalBytes: bytes,
    latestBytes: bytes,
    store: parsed.store,
    file: parsed.file,
    mtimeMs,
    lastRead: Date.now(),
  }
  clearOpenTarget()
  return parsed.file
}

async function openPath(path: string): Promise<WorkbookFile> {
  const fetched = await fetchPathBytes(path)
  return adoptWorkbook(path, fetched.name, fetched.bytes, fetched.mtimeMs)
}

async function openWebdoc(path: string): Promise<WorkbookFile> {
  const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
  if (!rec) throw new Error('load-error: missing browser file record')
  let bytes: Uint8Array
  let name = rec.name
  let mtimeMs = rec.mtime ?? null
  if (rec.kind === 'fs' && rec.handle) {
    const file = await rec.handle.getFile()
    bytes = new Uint8Array(await file.arrayBuffer())
    name = file.name
    mtimeMs = file.lastModified
  } else if (rec.bytes) {
    bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes)
  } else {
    throw new Error('load-error: empty browser file record')
  }
  return adoptWorkbook(path, name, bytes, mtimeMs)
}

/** Persist browser-owned files only. Disk `path:` writes stay on the control export path. */
async function persistOpened(): Promise<void> {
  if (!opened || !opened.path.startsWith('/webdoc/')) return
  const rec = await idbGet<WebFileRecord>(STORE_HANDLES, opened.path)
  if (rec?.handle && typeof rec.handle.createWritable === 'function') {
    const writable = await rec.handle.createWritable()
    const chunk = new Uint8Array(opened.latestBytes.byteLength)
    chunk.set(opened.latestBytes)
    await writable.write(chunk)
    await writable.close()
  }
  await idbPut(STORE_HANDLES, opened.path, {
    name: opened.name,
    kind: rec?.handle ? 'fs' : 'bytes',
    handle: rec?.handle,
    bytes: rec?.handle ? undefined : opened.latestBytes.buffer,
    mtime: Date.now(),
    accessedAt: Date.now(),
  })
}

/** control-mode export: the CURRENT workbook bytes (BR-008 — export is the
 *  only write-back payload; edits never touch disk directly). */
export async function exportCurrentBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!opened) return null
  return { bytes: opened.latestBytes, name: opened.name }
}

window.__genofficeExportBytes = exportCurrentBytes
window.__genofficeWorkbookFile = () => opened?.file ?? null

// ── window.desktopApi ───────────────────────────────────────────────────

const themeListeners = new Set<(theme: UiTheme) => void>()
const languageListeners = new Set<(lang: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar') => void>()
const aiStreamListeners = new Set<(chunk: AiStreamChunk) => void>()
const menuListeners = new Set<(action: MenuAction) => void>()

const desktopApi: DesktopApi = {
  getLanguage: async () => readLang(),
  onLanguageChanged: (handler) => {
    languageListeners.add(handler)
    return () => languageListeners.delete(handler)
  },
  getTheme: async () => readTheme(),
  onThemeChanged: (handler) => {
    themeListeners.add(handler)
    return () => themeListeners.delete(handler)
  },
  getAutoSaveDefault: async (): Promise<AutoSaveDefault> => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: () => () => {},
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: () => () => {},

  selectWorkbook: async () => {
    // control-mode / URL-driven open: `?open=path:` and home `/webdoc/` win;
    // otherwise fall back to a file picker (non-control browser semantics)
    const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
    if (target?.startsWith('path:')) {
      return openPath(target.slice('path:'.length))
    }
    if (target?.startsWith('/webdoc/')) {
      return openWebdoc(target)
    }
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const handles = await window.showOpenFilePicker({
          types: [{
            description: 'Excel 工作簿',
            accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
          }],
        })
        const handle = handles[0] as FileSystemFileHandle
        const file = await handle.getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        const parsed = await parseXlsxWorkbook(bytes, file.name)
        opened = {
          path: `/webdoc/${crypto.randomUUID()}/${file.name}`,
          name: file.name,
          originalBytes: bytes,
          latestBytes: bytes,
          store: parsed.store,
          file: parsed.file,
          mtimeMs: file.lastModified,
          lastRead: Date.now(),
        }
        return parsed.file
      } catch {
        return null
      }
    }
    return null
  },

  readWorkbookRange: async (request) => {
    if (!opened) throw new Error('No workbook open')
    return buildRangeResult(opened.store, request)
  },

  readWorkbookFormulas: async (request) => {
    if (!opened) throw new Error('No workbook open')
    return buildFormulaResult(opened.store, request.sheetId)
  },

  recalcWorkbook: async (_request): Promise<WorkbookRecalcResult> => {
    // browser has no IronCalc sidecar; the closure model handles formulas in
    // Univer. Return an empty recalc (renderer falls back to engine values).
    return { cells: [] }
  },

  readWorkbookMedia: async (request): Promise<WorkbookMediaResult> => {
    if (!opened) throw new Error('No workbook open')
    if (request.sessionId !== opened.file.sessionId) throw new Error('Unknown workbook session.')
    const visual = opened.file.visuals.find((candidate) => candidate.id === request.visualId)
    const mediaPath = visual?.mediaPath ?? visual?.fillMediaPath
    if (!mediaPath) throw new Error('Unknown workbook image.')
    return readMediaPart(opened.latestBytes, mediaPath)
  },

  readPivotDefinition: async (request): Promise<WorkbookPivotDefinition> => {
    if (!opened) throw new Error('No workbook open')
    if (request.sessionId !== opened.file.sessionId) throw new Error('Unknown workbook session.')
    return readPivotParts(opened.latestBytes, request.path, request.cachePath)
  },

  readLocalImage: async (request): Promise<LocalImageResult> => {
    const raw = request.path
    const resolved = raw.startsWith('~/') ? raw : raw
    const absolute = resolved.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resolved)
    if (!absolute) throw new Error('Image path must be absolute.')
    const fetched = await fetchPathBytes(resolved)
    if (fetched.bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error('Image exceeds the 20MB limit.')
    }
    const mediaType = sniffImageMediaType(fetched.bytes)
    if (mediaType === null) throw new Error('The image is not PNG/JPEG/GIF.')
    return { mediaType, base64: bytesToBase64(fetched.bytes) }
  },

  onChromePressed: () => () => {},

  captureScreenSources: async (): Promise<ScreenSourcesResult> => ({ status: 'denied', sources: [] }),

  captureScreenSource: async (): Promise<ScreenCaptureResult | null> => null,

  beginSaveEditsTransfer: async () => {
    throw new Error('Chunked save-edits transfer is unavailable in the web version')
  },
  sendSaveEditsChunk: async () => {
    throw new Error('Chunked save-edits transfer is unavailable in the web version')
  },
  abortSaveEditsTransfer: async () => {},

  saveWorkbookEdits: async (request: WorkbookSaveRequest): Promise<WorkbookSaveResult> => {
    if (!opened) throw new Error('No workbook open')
    const applied = await applySaveRequest(opened.latestBytes, opened.name, request)
    opened = {
      ...opened,
      latestBytes: applied.bytes,
      store: (await parseXlsxWorkbook(applied.bytes, opened.name)).store,
      file: applied.file,
      lastRead: Date.now(),
    }
    await persistOpened()
    return { canceled: false, file: applied.file, touchedEntries: [...applied.touchedEntries] }
  },

  writeWorkbookRecovery: async () => ({ ok: true }),

  autoRenameWorkbook: async () => ({ renamed: false }),

  exportPdf: async (request: WorkbookExportPdfRequest): Promise<WorkbookExportPdfResult> => {
    const destHint = (request as WorkbookExportPdfRequest & { dest?: string }).dest
    const stem = String(request.fileName || 'workbook').replace(/\.[^.]+$/, '')
    const dest =
      typeof destHint === 'string' && destHint.startsWith('/')
        ? destHint
        : opened?.path?.startsWith('/')
          ? `${opened.path.replace(/\/[^/]+$/, '')}/${stem}.pdf`
          : `/tmp/genoffice-web-print/${stem}.pdf`
    const printed = await runPrintJob({
      app: 'sheets',
      dest,
      html: request.html,
      landscape: request.landscape,
      pageSize: request.pageSize,
      margins: request.margins,
      scale: request.scale,
      headerTemplate: request.headerTemplate,
      footerTemplate: request.footerTemplate,
    })
    if (printed.canceled || printed.available === false) return { canceled: true }
    if (!printed.ok) return { canceled: true }
    return { canceled: false, path: printed.path ?? dest }
  },
  exportCsv: async () => ({ canceled: true as const }),
  confirmCsvSave: async () => 'cancel' as const,
  createDocument: async () => ({
    ok: false,
    error: '网页版暂不支持 create_document；请在本页直接编辑后显式保存',
  }),
  selectWorkbooksForMerge: async () => null,
  openWorkbooksForMerge: async () => null,

  closeWorkbook: async () => {
    opened = null
  },

  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener')
  },

  onMenuAction: (callback) => {
    menuListeners.add(callback)
    return () => menuListeners.delete(callback)
  },

  onWorkbookRenamed: () => () => {},

  notifyPendingEdits: () => {},

  onCloseSaveRequest: () => () => {},

  reportCloseSaveResult: () => {},

  onRecoveryPrompt: () => () => {},
  replyRecoveryPrompt: () => {},

  consumeNewBlankWorkbook: async () => {
    if (blankConsumed) return false
    blankConsumed = true
    return true
  },

  hasQueuedWorkbook: async () => {
    // URL-driven open: report once so the mount flow pulls the workbook
    const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
    if (!target || opened) return false
    return true
  },

  getAiSettings: async () => readAiSettings(),
  setAiSettings: async (settings) => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings))
  },

  aiChat: async (_request: AiChatRequest): Promise<AiChatResponse> => ({
    ok: false,
    error: '网页版暂不支持 AI 对话；请配置本地服务或使用桌面版',
  }),

  aiStream: async () => {},
  aiStreamCancel: async () => {},

  aiGskStatus: async (): Promise<GenSparkAccountStatus> => ({ loggedIn: false }),
  aiGskLogin: async () => {
    window.open('https://www.genspark.ai', '_blank', 'noopener')
  },

  imageSearch: async (query, maxResults) => {
    const ready = await relay<{ imageSearch?: { available?: boolean; reason?: string } }>('/providers/ready')
    if (!ready?.imageSearch?.available) {
      return { images: [], method: 'error', error: ready?.imageSearch?.reason ?? 'image-search-unconfigured' }
    }
    const res = await relay<{
      images?: Array<{ title?: string; imageUrl: string; sourceUrl?: string; source?: string; width?: number; height?: number }>
      method?: string
      error?: string
    }>('/search/image', { query, maxResults: maxResults ?? 6 })
    if (!res || res.method === 'error') {
      return { images: [], method: 'error', error: res?.error ?? 'image search needs the local relay' }
    }
    return {
      images: (res.images ?? []).map((img) => ({
        title: img.title ?? '',
        imageUrl: img.imageUrl,
        sourceUrl: img.sourceUrl ?? '',
        source: img.source ?? 'bing',
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
      })),
      method: res.method ?? 'ok',
    }
  },
  generateImage: async (op) => {
    const ready = await relay<{ generate?: { available?: boolean; reason?: string } }>('/providers/ready')
    if (!ready?.generate?.available) {
      return { error: ready?.generate?.reason ?? 'generate-provider-unconfigured' }
    }
    const res = await relay<{ url?: string; error?: string }>('/generate-image', { prompt: op.prompt, aspectRatio: op.aspectRatio })
    return res ?? { error: 'image generation needs the local relay' }
  },
  fetchImage: async (url) => {
    return await relay<{ base64: string; mime: string }>('/fetch-image', { url })
  },

  webSearch: async (query, maxResults) => {
    const res = await relay<{ results: Array<{ title: string; url: string; snippet: string }>; method: string; error?: string }>(
      '/search/web',
      { query, maxResults: maxResults ?? 5 },
    )
    if (res) return res
    return { results: [], method: 'error', error: '联网搜索需要本地中继服务（npm run web）' }
  },

  onAiStream: (handler) => {
    aiStreamListeners.add(handler)
    return () => aiStreamListeners.delete(handler)
  },

  pickAttachments: async (): Promise<AttachmentAddResult | null> => null,

  addAttachmentPaths: async (paths): Promise<AttachmentAddResult> => {
    const accepted: AttachmentMeta[] = []
    const rejected: string[] = []
    for (const path of paths) rejected.push(`找不到附件: ${path}`)
    return { accepted, rejected }
  },

  addPastedImage: async (): Promise<AttachmentAddResult> => ({ accepted: [], rejected: ['网页版暂不支持粘贴图片附件'] }),

  readAttachment: async (): Promise<AttachmentReadResult> => ({ ok: false, error: '附件不可用' }),

  readAttachmentImage: async (): Promise<AttachmentImageResult> => ({ ok: false, error: '附件不可用' }),

  getPathForFile: () => `/webdoc/${crypto.randomUUID()}/dropped-file`,
}

// ── window.projectApi (minimal in-memory chat persistence) ──────────────

const projectApi: ProjectApi = {
  resolveChat: async ({ filePath, tempChatId }) => ({
    projectId: 'web-default',
    chatId: tempChatId ?? (filePath ? `file-${filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)}` : 'default'),
  }),
  appendChat: async () => {},
  loadChat: async () => [],
  rebindChat: async ({ projectId, tempChatId, newChatId, newFilePath }) => ({
    projectId,
    chatId: newChatId ?? (newFilePath ? `file-${newFilePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)}` : 'default'),
  }),
  listProjects: async () => [
    {
      id: 'web-default',
      name: '网页版项目',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
      fileCount: 0,
      lastActiveAt: new Date().toISOString(),
      isDefault: true,
    },
  ],
  createProject: async ({ name }) => ({
    id: 'web-default',
    name,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
    fileCount: 0,
    lastActiveAt: new Date().toISOString(),
    isDefault: true,
  }),
  renameProject: async () => {},
  deleteProject: async () => {},
  moveFile: async () => {},
  getTimeline: async () => [],
}

// ── drag & drop / URL cleanup ───────────────────────────────────────────

/** strip ?open=/?file= (and ?control= is handled by control.ts) from the URL */
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

// ── install ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  // env.d.ts declares the preload surfaces as readonly — the web bridge
  // installs them at runtime (same pattern as the docs web bridge)
  ;(window as unknown as { desktopApi: DesktopApi }).desktopApi = desktopApi
  ;(window as unknown as { projectApi: ProjectApi }).projectApi = projectApi
}

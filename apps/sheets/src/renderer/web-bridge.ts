/**
 * GenOffice Sheets — Web bridge (genoffice-dsh-office).
 *
 * Stand-in for the Electron preload bridge (`window.desktopApi` /
 * `window.projectApi`) that lets the *unmodified* sheets renderer run in a
 * plain browser tab:
 *
 *   - open via URL  `/sheets/?open=path:<abs>` → relay `/api/file` bytes →
 *     browser xlsx parse (web-xlsx.ts) → `WorkbookFile` (lazy model intact)
 *   - range/formula reads → in-memory parsed store
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
} from '../shared/desktop-api'
import {
  applySaveRequest,
  buildFormulaResult,
  buildRangeResult,
  parseXlsxWorkbook,
  type ParsedWorkbook,
} from './web-xlsx'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
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
/** synthetic path → bytes for files opened without a path: (unused for now) */

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

/** absolute-path open target from the URL (`?open=path:…` / `?file=…`) */
function openPathFromUrl(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v?.startsWith('path:')) return v.slice('path:'.length)
  }
  return null
}

async function fetchPathBytes(path: string): Promise<{ bytes: Uint8Array; name: string; mtimeMs: number | null } | null> {
  const res = await relay<{ ok: boolean; base64?: string; name?: string; mtimeMs?: number | null; error?: string }>(
    `/file?path=${encodeURIComponent(path)}`,
  )
  if (!res?.ok || !res.base64) return null
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  return { bytes: bin, name: res.name ?? path.split('/').pop() ?? 'workbook.xlsx', mtimeMs: res.mtimeMs ?? null }
}

async function openPath(path: string): Promise<WorkbookFile | null> {
  const fetched = await fetchPathBytes(path)
  if (!fetched) return null
  const parsed = await parseXlsxWorkbook(fetched.bytes, fetched.name)
  opened = {
    path,
    name: fetched.name,
    originalBytes: fetched.bytes,
    latestBytes: fetched.bytes,
    store: parsed.store,
    file: parsed.file,
    mtimeMs: fetched.mtimeMs,
    lastRead: Date.now(),
  }
  clearOpenTarget()
  return parsed.file
}

/** control-mode export: the CURRENT workbook bytes (BR-008 — export is the
 *  only write-back payload; edits never touch disk directly). */
export async function exportCurrentBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!opened) return null
  return { bytes: opened.latestBytes, name: opened.name }
}

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

  selectWorkbook: async () => {
    // control-mode / URL-driven open: `?open=path:` wins; otherwise fall back
    // to a file picker (non-control browser semantics)
    const target = openPathFromUrl()
    if (target) {
      try {
        return await openPath(target)
      } catch (e) {
        console.error('[web-sheets] open failed:', e)
        return null
      }
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

  readWorkbookMedia: async (): Promise<WorkbookMediaResult> => {
    throw new Error('readWorkbookMedia is unavailable in the web version')
  },

  readPivotDefinition: async (): Promise<WorkbookPivotDefinition> => {
    throw new Error('readPivotDefinition is unavailable in the web version')
  },

  readLocalImage: async (): Promise<LocalImageResult> => {
    throw new Error('readLocalImage is unavailable in the web version')
  },

  captureScreenSources: async (): Promise<ScreenSourcesResult> => ({ status: 'denied', sources: [] }),

  captureScreenSource: async (): Promise<ScreenCaptureResult | null> => null,

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
    return { canceled: false, file: applied.file, touchedEntries: [...applied.touchedEntries] }
  },

  writeWorkbookRecovery: async () => ({ ok: true }),

  autoRenameWorkbook: async () => ({ renamed: false }),

  exportPdf: async (_request: WorkbookExportPdfRequest): Promise<WorkbookExportPdfResult> => ({
    canceled: true,
  }),

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

  consumeNewBlankWorkbook: async () => {
    if (blankConsumed) return false
    blankConsumed = true
    return true
  },

  hasQueuedWorkbook: async () => {
    // URL-driven open: report once so the mount flow pulls the workbook
    const target = openPathFromUrl()
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

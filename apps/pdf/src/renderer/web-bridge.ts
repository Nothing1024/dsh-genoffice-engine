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
import { applySaveRequest } from './web-pdf-save'
import { validateTextEdits as validateTextEditsImpl } from './web-text-edit'
import { listEditFonts as listEditFontsImpl } from './web-text-edit'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
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
}

let opened: WebPdfState | null = null

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

function openPathFromUrl(): string | null {
  const params = new URLSearchParams(location.search)
  for (const key of ['open', 'file']) {
    const v = params.get(key)
    if (v?.startsWith('path:')) return v.slice('path:'.length)
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
  if (changed) history.replaceState(null, '', url)
}

async function fetchPathBytes(path: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  const res = await relay<{ ok: boolean; base64?: string; name?: string; error?: string }>(
    `/file?path=${encodeURIComponent(path)}`,
  )
  if (!res?.ok || !res.base64) return null
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  return { bytes: bin, name: res.name ?? path.split('/').pop() ?? 'document.pdf' }
}

/** control-mode write-back payload (BR-008): CURRENT merged bytes. */
export async function exportPdfBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!opened) return null
  return { bytes: opened.bytes, name: opened.name }
}

// ── window.pdfApi ───────────────────────────────────────────────────────

const aiStreamListeners = new Set<(chunk: AiStreamChunk) => void>()
const closeSaveListeners = new Set<() => void>()
const saveAsListeners = new Set<(targetPath: string) => void>()
const saveAsFlowListeners = new Set<(inFlight: boolean) => void>()
const themeListeners = new Set<(theme: UiTheme) => void>()

const pdfApi: PdfApi = {
  consumePending: async () => {
    const target = openPathFromUrl()
    if (!target) return null
    const fetched = await fetchPathBytes(target)
    if (!fetched) return null
    opened = { path: target, bytes: fetched.bytes, name: fetched.name }
    clearOpenTarget()
    return target
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
    opened = { path, bytes: fetched.bytes, name: fetched.name }
    return fetched.bytes.buffer.slice(
      fetched.bytes.byteOffset,
      fetched.bytes.byteOffset + fetched.bytes.byteLength,
    ) as ArrayBuffer
  },

  save: async (request: SavePdfRequest): Promise<SavePdfResult> => {
    if (!opened) return { ok: false, error: 'no file open' }
    try {
      const applied = await applySaveRequest(opened.bytes, request)
      opened = { ...opened, bytes: applied.bytes }
      return {
        ok: true,
        ...(applied.skippedTextEdits.length > 0 ? { skippedTextEdits: applied.skippedTextEdits } : {}),
        ...(applied.skippedImageEdits.length > 0 ? { skippedImageEdits: applied.skippedImageEdits } : {}),
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  validateTextEdits: async (request) => {
    if (!opened) return request.edits.map((e) => ({ pageIndex: e.pageIndex, oldText: e.oldText, reason: 'no file open' }))
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

  extractPages: async () => ({ ok: true, canceled: true }),

  insertPdf: async () => ({ ok: true, canceled: true }),

  exportImages: async () => ({ ok: true, canceled: true }),

  imageSearch: async (query, maxResults) => {
    const res = await relay<{ images: Array<{ title: string; imageUrl: string; sourceUrl: string; width?: number; height?: number }>; method: string; error?: string }>(
      '/search/image',
      { query, maxResults: maxResults ?? 6 },
    )
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
  canDrawText: async () => true,
  listStaticFormFills: async () => [],
  insertBlankPage: async () => ({
    ok: false as const,
    error: 'insertBlankPage is not supported in the web version',
  }),
  splitPdf: async () => ({ ok: true as const, canceled: true as const }),
  mergePdf: async () => ({ ok: true as const, canceled: true as const }),
  mergePages: async () => ({ ok: true as const, canceled: true as const }),
  replacePages: async () => ({ ok: true as const, canceled: true as const }),
  setPageSize: async () => ({
    ok: false as const,
    error: 'setPageSize is not supported in the web version',
  }),
  splitPages: async () => ({
    ok: false as const,
    error: 'splitPages is not supported in the web version',
  }),
  cropPages: async () => ({
    ok: false as const,
    error: 'cropPages is not supported in the web version',
  }),
  convertOffice: async () => {
    throw new Error('PDF conversion to Word/Excel/PowerPoint is not supported in the web version')
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
  onThemeChanged: (handler) => {
    themeListeners.add(handler)
    return () => themeListeners.delete(handler)
  },

  getAiSettings: async () => readAiSettings(),
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

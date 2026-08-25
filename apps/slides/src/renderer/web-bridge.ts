/**
 * GenOffice Slides — Web bridge (genoffice-dsh-office, web build only).
 *
 * Stand-in for the Electron preload bridge (`window.slidesApi`) that lets the
 * *unmodified* slides renderer run in a plain browser tab. The heavy lifting
 * lives in web-slides-session.ts (pptx-engine/pptx-render session model).
 *
 * Scope per the P0 strategy (evidence/phase-0/web-strategy.md):
 *   - implemented: open (?open=path: → relay /api/file), save (pptx bytes),
 *     text/transform/fill/stroke/background edits, element add/delete,
 *     slide add/delete, undo/redo, notes, render rebuilds, theme/language,
 *     picture crop/opacity/replace/insert-url, group/ungroup, flip, text
 *     anchor, image fill, tables, charts, SmartArt, localStorage style templates,
 *     local generate_deck (spec JSON → pptx-engine → cloudpptx: marker landing),
 *     BYOK aiStream (no Genspark cloud page gen)
 *   - NOT implemented (explicit `console.warn` + null/default — never silent):
 *     presenter/audience, PDF/image export, print, master view, cloud gen,
 *     clipboard, animations, comments, sections, find-replace
 *   - generateImage / analyzeMedia → localhost relay (no browser net egress)
 */
import './web-node-shims'
import type {
  AddChartOp,
  AddElementOp,
  AddImageBytesOp,
  AddSmartArtOp,
  AddSlideOp,
  AddBlankSlideOp,
  AddTableOp,
  ApplyTxnOp,
  ApplyTxnResult,
  BatchEditTransformOp,
  DesktopFilesApi,
  EditBackgroundOp,
  EditChartOp,
  EditFillOp,
  EditPictureOpacityOp,
  EditPictureSrcRectOp,
  EditStrokeOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditTextOp,
  EditTransformOp,
  FlipElementOp,
  GroupElementsOp,
  MenuCommand,
  OpenResult,
  ReplacePictureBytesOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  SetNotesOp,
  SetTableCellAnchorOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SlidesApi,
  TableMergeIpcOp,
  TableStructureIpcOp,
  UngroupElementOp,
  UiTheme,
} from '../shared/ipc'
import { runTxn } from '../main/ops/executor'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import { defaultAiSettings, streamForProvider } from '@genoffice/ai-provider'
import {
  addChart,
  addPicture,
  addSmartArt,
  addTable,
  editChartElement,
  editPictureSrcRect,
  editTableCellText,
  editTableStructure,
  editTableStyle,
  ensureTableStylePart,
  findGroupChild,
  getChartElementData,
  groupElements,
  markChartEditable,
  mergeTableCells,
  parseTheme,
  replacePictureBytes,
  setElementImageFill,
  setElementTextAnchor,
  setPictureOpacity,
  setTableCellAnchor,
  setTableColWidth,
  setTableRowHeight,
  TABLE_STYLE_PRESETS,
  ungroupElement,
  updateConnectorsForMoved,
  type OpenedPptx,
  type Paragraph,
  type TableStructureOp,
  type TableStyleEdit,
} from '@genoffice/pptx-engine'
import {
  beginHistoryBatch,
  EMU_PER_PT,
  EMU_PER_PX_96,
  endHistoryBatch,
  getWebSession,
  buildAllRenderSlides,
  pushHistory,
  rebuildSlide,
  rebuildSlideWithReparse,
  sessionDirty,
  webAddBlankSlide,
  webAddElement,
  webAddSlide,
  webBatchEditTransform,
  webDeleteElement,
  webDeleteSlide,
  webEditBackground,
  webEditFill,
  webEditStroke,
  webEditText,
  webEditTransform,
  webGetNotes,
  webHtmlToPptx,
  webNewBlank,
  webOpenBytes,
  webRedo,
  webReorderElement,
  webSaveBytes,
  webSetElementFont,
  webSetElementParagraphFormat,
  webSetNotes,
  webUndo,
  type WebSlideSession,
} from './web-slides-session'
import { parsePageSpec, buildPagePptx } from '../shared/page-spec'
import { issueCloudPage } from '../shared/cloud-page-marker'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    __genofficeExportBytes?: () => Promise<{ bytes: Uint8Array; name: string } | null>
    showOpenFilePicker?: (options?: unknown) => Promise<unknown[]>
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

// ── relay helpers ───────────────────────────────────────────────────────

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

async function openPath(path: string, fitWidthPx: number): Promise<OpenResult | null> {
  const res = await relay<{ ok: boolean; base64?: string; name?: string; error?: string }>(
    `/file?path=${encodeURIComponent(path)}`,
  )
  if (!res?.ok || !res.base64) return null
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  const result = await webOpenBytes(bin, path, fitWidthPx)
  clearOpenTarget()
  return result
}

// ── event listeners (registered by the renderer) ────────────────────────

const openedListeners = new Set<(result: OpenResult) => void>()
const renamedListeners = new Set<(path: string) => void>()
const menuListeners = new Set<(command: MenuCommand) => void>()
const closeSaveListeners = new Set<() => void>()
const aiStreamListeners = new Set<(chunk: AiStreamChunk) => void>()
const themeListeners = new Set<(theme: UiTheme) => void>()
const historyChangedListeners = new Set<(state: { canUndo: boolean; canRedo: boolean }) => void>()
const activeAiStreams = new Map<string, AbortController>()

function emitAiChunk(chunk: AiStreamChunk): void {
  for (const listener of aiStreamListeners) {
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
  if (!config?.apiKey || provider === 'genspark') {
    emitAiChunk({
      requestId,
      type: 'error',
      error: 'web control mode has no local LLM',
    })
    return
  }
  if (!config.model) {
    emitAiChunk({ requestId, type: 'error', error: 'web control mode has no local LLM' })
    return
  }
  const controller = new AbortController()
  activeAiStreams.set(requestId, controller)
  let lastPing = 0
  const ping = () => {
    const now = Date.now()
    if (now - lastPing < 5_000) return
    lastPing = now
    emitAiChunk({ requestId, type: 'ping' })
  }
  try {
    let stopReason: string | undefined
    await streamForProvider(provider, config, system, messages, tools, maxTokens, {
      signal: controller.signal,
      onDelta: (text) => emitAiChunk({ requestId, type: 'delta', text }),
      onToolCall: (toolCall) => emitAiChunk({ requestId, type: 'tool-call', toolCall }),
      onActivity: ping,
      onStopReason: (reason) => {
        stopReason = reason
      },
    })
    emitAiChunk({ requestId, type: 'done', stopReason })
  } catch (err) {
    if (controller.signal.aborted) {
      emitAiChunk({ requestId, type: 'done' })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      const isTimeout = message.includes('timeout') || message.includes('Timeout')
      emitAiChunk({
        requestId,
        type: 'error',
        error: message,
        errorCode: isTimeout ? 'timeout' : undefined,
      })
    }
  } finally {
    activeAiStreams.delete(requestId)
  }
}

async function imageDimsForSpec(
  bytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart]))
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size.width > 0 && size.height > 0 ? size : null
    }
  } catch {
    /* fall through to Image */
  }
  try {
    const size = await imageNaturalSize(bytes)
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}


// ── explicit not-available stub (防呆: never silent) ────────────────────

function notAvailable(method: string): Promise<never> {
  console.warn(`[web-slides] ${method} is not available in the web version (documented subset)`)
  return Promise.resolve(null as never)
}

function toEmu(session: WebSlideSession, fitWidthPx: number, px: number): number {
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = fitWidthPx / baseWidthPx
  return Math.round((px / scale) * EMU_PER_PX_96)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('bmp')) return 'bmp'
  return 'jpg'
}

async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
  const data = /^data:([^;]+);base64,(.+)$/.exec(url)
  if (data) return { bytes: base64ToBytes(data[2]!), ext: extFromMime(data[1]!) }
  const relayed = await relay<{ base64?: string; mime?: string; error?: string }>('/fetch-image', {
    url,
  })
  if (relayed?.base64) {
    return { bytes: base64ToBytes(relayed.base64), ext: extFromMime(relayed.mime ?? '') }
  }
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) return null
    const bytes = new Uint8Array(await resp.arrayBuffer())
    return { bytes, ext: extFromMime(resp.headers.get('content-type') ?? '') }
  } catch {
    return null
  }
}

async function pickImageFile(): Promise<{ bytes: Uint8Array; ext: string } | null> {
  try {
    if (typeof window.showOpenFilePicker === 'function') {
      const handles = (await window.showOpenFilePicker({
        types: [
          {
            description: 'Images',
            accept: {
              'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'],
            },
          },
        ],
        multiple: false,
      })) as FileSystemFileHandle[]
      const file = await handles[0]?.getFile()
      if (!file) return null
      const bytes = new Uint8Array(await file.arrayBuffer())
      const ext = (file.name.split('.').pop() ?? 'png').toLowerCase()
      return { bytes, ext }
    }
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return null
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff'
    input.onchange = async () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const ext = (file.name.split('.').pop() ?? 'png').toLowerCase()
      resolve({ bytes, ext })
    }
    input.oncancel = () => {
      input.remove()
      resolve(null)
    }
    input.click()
  })
}

function imageNaturalSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const blob = new Blob([bytes as unknown as BlobPart])
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth || 4, height: img.naturalHeight || 3 })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve({ width: 4, height: 3 })
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

// ── style templates (localStorage) ──────────────────────────────────────

const STYLE_TEMPLATES_KEY = 'genoffice-style-templates'
const STYLE_SIDECAR_KEY = 'genoffice-style-sidecar'

interface StyleTemplateRecord {
  name: string
  topic: string
  styleSkill: string
  createdAt: string
}

function readStyleTemplates(): StyleTemplateRecord[] {
  try {
    const raw = localStorage.getItem(STYLE_TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StyleTemplateRecord[]) : []
  } catch {
    return []
  }
}

function writeStyleTemplates(list: StyleTemplateRecord[]): void {
  localStorage.setItem(STYLE_TEMPLATES_KEY, JSON.stringify(list))
}

function safeTemplateName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
}

function upsertStyleTemplate(entry: StyleTemplateRecord): void {
  const list = readStyleTemplates()
  const idx = list.findIndex((t) => t.name === entry.name)
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  writeStyleTemplates(list)
}

// ── table style / chart helpers (mirrors slides-main.ts) ────────────────

function tableStyleEditFromOp(session: WebSlideSession, op: EditTableStyleOp): TableStyleEdit {
  if (op.styleName && TABLE_STYLE_PRESETS[op.styleName]) {
    const preset = TABLE_STYLE_PRESETS[op.styleName]!
    if (preset.styleId && preset.styleDefXml) {
      ensureTableStylePart(session.opened, preset.styleId, preset.styleDefXml)
    }
    return {
      tblPrXml: preset.tblPrXml,
      clearDirectFormatting: true,
      ...(preset.border
        ? {
            borderPreset: 'all' as const,
            borderColor: preset.border.color,
            borderWidthEmu: preset.border.widthEmu,
          }
        : {}),
    }
  }
  const borderColor = op.borderColor ?? undefined
  const borderWidthEmu =
    op.borderWidthPt != null ? Math.round(op.borderWidthPt * EMU_PER_PT) : undefined
  return {
    ...(op.firstRow !== undefined ? { firstRow: op.firstRow } : {}),
    ...(op.bandRow !== undefined ? { bandRow: op.bandRow } : {}),
    ...(op.shadingColor !== undefined ? { shadingColor: op.shadingColor } : {}),
    ...(op.borderPreset !== undefined ? { borderPreset: op.borderPreset } : {}),
    ...(borderColor !== undefined ? { borderColor } : {}),
    ...(borderWidthEmu !== undefined ? { borderWidthEmu } : {}),
    ...(op.cells ? { cells: op.cells } : {}),
  }
}

const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']
const CHART_COLOR_SCHEMES: Record<string, string[]> = {
  default: [],
  blue: ['#2E75B6', '#4472C4', '#5B9BD5', '#70AD47', '#ED7D31'],
  warm: ['#ED7D31', '#FFC000', '#FF0000', '#C55A11', '#833C00'],
  cool: ['#0070C0', '#00B0F0', '#00B0A0', '#7030A0', '#2E75B6'],
  mono: ['#404040', '#666666', '#888888', '#AAAAAA', '#CCCCCC'],
}

function mixHex(hex: string, target: number, ratio: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1]!, 16)
  const ch = (x: number) => Math.round(x + (target - x) * ratio)
  const r = ch((v >> 16) & 255)
  const g = ch((v >> 8) & 255)
  const b = ch(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`
}

function deckAccents(opened: OpenedPptx): string[] {
  const slide = opened.deck.slides[0]
  if (!slide) return FALLBACK_ACCENTS
  try {
    const chain = opened.archive.resolveSlideChain(slide.path)
    const xml = chain.themePath ? opened.archive.readText(chain.themePath) : null
    const colors = xml ? parseTheme(xml).colors : undefined
    const acc = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((k) => colors?.[k])
      .filter((c): c is string => !!c)
    return acc.length >= 3 ? acc : FALLBACK_ACCENTS
  } catch {
    return FALLBACK_ACCENTS
  }
}

function chartColorSchemes(
  opened: OpenedPptx,
): Array<{ key: string; label: string; colors: string[] }> {
  const acc = deckAccents(opened)
  const rot = [...acc.slice(3), ...acc.slice(0, 3)]
  const mono = (c: string) => [
    mixHex(c, 0, 0.25),
    c,
    mixHex(c, 255, 0.25),
    mixHex(c, 255, 0.45),
    mixHex(c, 255, 0.65),
  ]
  return [
    { key: 'default', label: 'Theme', colors: [] },
    { key: 'colorful', label: 'Colorful', colors: acc },
    { key: 'colorful2', label: 'Colorful 2', colors: rot },
    ...acc.map((c, i) => ({
      key: `mono-accent${i + 1}`,
      label: `Mono ${i + 1}`,
      colors: mono(c),
    })),
  ]
}

// ── window.slidesApi ────────────────────────────────────────────────────

let autoSavePref = true

const slidesApi: SlidesApi = {
  getLanguage: async () => readLang(),
  onLanguageChanged: () => () => {},
  getTheme: async () => readTheme(),
  onThemeChanged: (handler) => {
    themeListeners.add(handler)
    return () => themeListeners.delete(handler)
  },
  onChromePressed: () => () => {},
  setShowFullScreen: async () => {
    console.warn('[web-slides] setShowFullScreen is not available in the web version')
  },
  privateFontFaces: async () => [],
  privateFontData: async () => null,

  openPptx: async (fitWidthPx) => {
    const target = openPathFromUrl()
    if (target) {
      try {
        return await openPath(target, fitWidthPx)
      } catch (e) {
        console.error('[web-slides] open failed:', e)
        return null
      }
    }
    return notAvailable('openPptx (dialog)')
  },

  openPptxPath: async (path, fitWidthPx) => {
    try {
      return await openPath(path, fitWidthPx)
    } catch (e) {
      console.error('[web-slides] open failed:', e)
      return null
    }
  },

  consumePendingOpen: async (fitWidthPx) => {
    const target = openPathFromUrl()
    if (!target) return null
    try {
      return await openPath(target, fitWidthPx)
    } catch (e) {
      console.error('[web-slides] open failed:', e)
      return null
    }
  },

  newBlank: async (fitWidthPx) => webNewBlank(fitWidthPx),

  htmlToPptx: async (pagesHtml, fitWidthPx, mode, atIndex) =>
    webHtmlToPptx(pagesHtml, fitWidthPx, mode, atIndex),

  cloudGenStatus: async () => ({ enabled: false }),

  cloudGeneratePage: async () => ({ ok: false, error: '网页版暂不支持云端生成' }),
  localGeneratePage: async (op) => {
    const parsed = parsePageSpec(String(op?.specJson ?? ''))
    if (!parsed.ok) return { ok: false, error: parsed.error }
    try {
      const { bytes, imageFailures } = await buildPagePptx(parsed.spec, {
        fetchImage: fetchImageBytes,
        imageDims: imageDimsForSpec,
      })
      return {
        ok: true,
        marker: issueCloudPage(bytes, crypto.randomUUID()),
        ...(imageFailures.length ? { imageFailures } : {}),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  editText: async (op: EditTextOp) => {
    const session = getWebSession()
    if (!session) return null
    return webEditText(session, op)
  },

  setElementFont: async (op: SetElementFontOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    beginHistoryBatch(session)
    let changed = false
    for (const id of op.sourceIds) {
      const ok = webSetElementFont(session, {
        slideIndex: op.slideIndex,
        sourceId: id,
        patch: {
          fontFamily: op.fontFamily,
          fontSizePt: op.fontSizePt,
          strike: op.strike,
          bold: op.bold,
          italic: op.italic,
          underline: op.underline,
          color: op.color,
        },
      })
      if (ok) changed = true
    }
    endHistoryBatch(session)
    if (!changed) {
      // Nothing was pushed (all sourceIds invalid) — do not pop a pre-existing snapshot
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },

  setElementParagraphFormat: async (op: SetElementParagraphFormatOp) => {
    const session = getWebSession()
    if (!session) return null
    const patch = {
      bullet: op.bullet,
      bulletChar: op.bulletChar,
      bulletHangEmu: op.bulletHangEmu,
      bulletSizePct: op.bulletSizePct,
      bulletColor: op.bulletColor,
      lineSpacingPct: op.lineSpacingPct,
      spaceBeforePt: op.spaceBeforePt,
      spaceAfterPt: op.spaceAfterPt,
      align: op.align,
      indentDelta: op.indentDelta,
    }
    let rendered: RenderSlide | null = null
    beginHistoryBatch(session)
    for (const id of op.sourceIds) {
      rendered = webSetElementParagraphFormat(session, {
        slideIndex: op.slideIndex,
        sourceId: id,
        patch,
      })
    }
    endHistoryBatch(session)
    return rendered
  },

  findReplace: async () => notAvailable('findReplace'),

  setSlideLayout: async () => notAvailable('setSlideLayout'),
  setSlideSize: async () => notAvailable('setSlideSize'),
  getSlideSize: async () => {
    const session = getWebSession()
    if (!session) return null
    return { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy }
  },

  applyTheme: async () => notAvailable('applyTheme'),
  setSlideHidden: async () => notAvailable('setSlideHidden'),
  setSections: async () => notAvailable('setSections'),
  moveSlide: async () => notAvailable('moveSlide'),
  nativeClipboard: async () => {},
  beginHistoryBatch: async () => {
    const session = getWebSession()
    if (!session) return false
    beginHistoryBatch(session)
    return true
  },
  endHistoryBatch: async () => {
    const session = getWebSession()
    if (!session) return null
    endHistoryBatch(session)
    return null
  },
  applyEditScript: async () => notAvailable('applyEditScript'),
  applyTxn: async (req: ApplyTxnOp): Promise<ApplyTxnResult | null> => {
    const session = getWebSession()
    if (!session) return null
    const ops = Array.isArray(req?.ops) ? (req.ops as Parameters<typeof runTxn>[1]['ops']) : []
    if (ops.length === 0 || ops.length > 50) {
      return {
        applied: false,
        failures: [
          { index: 0, error: 'ops must be a non-empty array (at most 50 per transaction).' },
        ],
      }
    }
    const isolation = req.isolation === 'per_op' ? ('per_op' as const) : ('atomic' as const)
    const compact = (fails?: Array<{ index: number; error: string }>) =>
      fails?.map((f) => ({ index: f.index, error: f.error }))
    if (req.dryRun) {
      const r = runTxn(session.opened, { ops, isolation, dryRun: true })
      return {
        applied: false,
        dryRun: true,
        plan: r.plan ?? [],
        ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
      }
    }
    // Plan before pushing history (a no-op request must not clear the redo stack)
    const plan = runTxn(session.opened, { ops, isolation, dryRun: true })
    const invalid = plan.failures?.length ?? 0
    if (isolation === 'atomic' ? invalid > 0 : invalid >= ops.length) {
      return { applied: false, failures: compact(plan.failures) }
    }
    pushHistory(session)
    const r = runTxn(session.opened, { ops, isolation })
    if (!r.applied) {
      session.undoStack.pop()
      return { applied: false, failures: compact(r.failures) }
    }
    return {
      applied: true,
      records: (r.records ?? []).map((rec) => ({
        op: rec.op.op,
        ...(rec.op.target
          ? { target: `${rec.op.target.slide}${rec.op.target.el ? `/${rec.op.target.el}` : ''}` }
          : {}),
        ...(rec.created ? { created: rec.created } : {}),
      })),
      ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
      slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
    }
  },
  onHistoryChanged: (handler) => {
    historyChangedListeners.add(handler)
    return () => historyChangedListeners.delete(handler)
  },
  aiSnapshotRestore: async () => notAvailable('aiSnapshotRestore'),
  editTableStyle: async (op: EditTableStyleOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const elIdx = slide.elements.findIndex((el) => el.id === op.sourceId)
    pushHistory(session)
    const edit = tableStyleEditFromOp(session, op)
    if (!editTableStyle(slide, op.sourceId, edit)) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  },
  gskStatus: async () => {
    const res = await relay<{ available: boolean; email?: string }>('/gsk-status')
    return res ?? { available: false }
  },
  addSlideWithLayout: async () => notAvailable('addSlideWithLayout'),

  editTransform: async (op: EditTransformOp) => {
    const session = getWebSession()
    if (!session) return null
    return webEditTransform(session, op)
  },

  editConnectorEndpoints: async () => notAvailable('editConnectorEndpoints'),

  batchEditTransform: async (op: BatchEditTransformOp) => {
    const session = getWebSession()
    if (!session) return null
    return webBatchEditTransform(session, op)
  },

  getRenderSlides: async () => {
    const session = getWebSession()
    if (!session) return null
    return session.opened.deck.slides.map((s, i) =>
      rebuildSlide(session, i),
    ) as unknown as RenderSlide[]
  },

  editPictureSrcRect: async (op: EditPictureSrcRectOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!editPictureSrcRect(slide, op.sourceId, op.srcRect)) {
      session.undoStack.pop()
      return null
    }
    if (op.boxPx && op.fitWidthPx) {
      const el = slide.elements.find((x) => x.id === op.sourceId)
      if (el) {
        el.transform = {
          ...el.transform,
          offset: {
            x: toEmu(session, op.fitWidthPx, op.boxPx.x),
            y: toEmu(session, op.fitWidthPx, op.boxPx.y),
            cx: toEmu(session, op.fitWidthPx, op.boxPx.w),
            cy: toEmu(session, op.fitWidthPx, op.boxPx.h),
          },
        }
        el.dirtyTransform = true
        updateConnectorsForMoved(slide, [op.sourceId])
      }
    }
    return rebuildSlide(session, op.slideIndex)
  },
  editPictureOpacity: async (op: EditPictureOpacityOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setPictureOpacity(slide, op.sourceId, op.opacity)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  editImageFill: async (op) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    let bytes: Uint8Array
    let ext: string
    if (op.source) {
      bytes = Uint8Array.from(atob(op.source.base64), (c) => c.charCodeAt(0))
      ext = op.source.ext
    } else {
      const picked = await pickImageFile()
      if (!picked) return null
      bytes = picked.bytes
      ext = picked.ext
    }
    pushHistory(session)
    const tile = op.mode === 'tile'
    let mediaPath: string | null = null
    for (const target of op.targets) {
      const source = mediaPath ? { mediaPath } : { bytes, ext }
      const landed = setElementImageFill(session.opened, slide, target.sourceId, source, {
        tile,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!landed) {
        session.undoStack.pop()
        return null
      }
      mediaPath = landed
    }
    return rebuildSlide(session, op.slideIndex)
  },
  changeShape: async () => notAvailable('changeShape'),
  setShapeAdjust: async () => notAvailable('setShapeAdjust'),
  setTextAnchor: async (op) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setElementTextAnchor(slide, op.sourceId, op.anchor)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  clipboardExternal: async () => ({ kind: 'none' }),

  groupElements: async (op: GroupElementsOp) => {
    const session = getWebSession()
    if (!session) return null
    pushHistory(session)
    const result = groupElements(session.opened, op.slideIndex, op.sourceIds)
    if (!result) {
      session.undoStack.pop()
      return null
    }
    const renderSlide = rebuildSlide(session, op.slideIndex)
    return renderSlide ? { slide: renderSlide, groupId: result.groupId } : null
  },
  ungroupElement: async (op: UngroupElementOp) => {
    const session = getWebSession()
    if (!session) return null
    pushHistory(session)
    const fresh = ungroupElement(session.opened, op.slideIndex, op.sourceId)
    if (!fresh) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },

  addElement: async (op: AddElementOp) => {
    const session = getWebSession()
    if (!session) return null
    return webAddElement(session, op)
  },

  deleteElement: async (op: { slideIndex: number; sourceId: string }) => {
    const session = getWebSession()
    if (!session) return null
    return webDeleteElement(session, op)
  },

  addSlide: async (op: AddSlideOp) => {
    const session = getWebSession()
    if (!session) return null
    return webAddSlide(session, op)
  },

  addBlankSlide: async (op: AddBlankSlideOp) => {
    const session = getWebSession()
    if (!session) return null
    return webAddBlankSlide(session, op)
  },

  copySlide: async () => false,
  pasteSlide: async () => null,
  repasteSlide: async () => null,
  hasSlideClipboard: async () => false,

  deleteSlide: async (slideIndex: number) => {
    const session = getWebSession()
    if (!session) return null
    return webDeleteSlide(session, slideIndex)
  },

  reorderElement: async (op: { slideIndex: number; sourceId: string; dir: 'front' | 'back' | 'forward' | 'backward' }) => {
    const session = getWebSession()
    if (!session) return null
    return webReorderElement(session, op)
  },

  editTableCell: async (op: EditTableCellOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!editTableCellText(slide, op.sourceId, op.row, op.col, op.paragraphs as Paragraph[])) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  tableStructure: async (op: TableStructureIpcOp) => {
    const session = getWebSession()
    if (!session) return null
    pushHistory(session)
    const r = editTableStructure(session.opened, op.slideIndex, op.sourceId, {
      kind: op.kind,
      index: op.index,
      ...(op.before ? { before: true } : {}),
    } as TableStructureOp)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  },
  tableMerge: async (op: TableMergeIpcOp) => {
    const session = getWebSession()
    if (!session) return null
    pushHistory(session)
    const r = mergeTableCells(session.opened, op.slideIndex, op.sourceId, {
      kind: op.kind,
      row: op.row,
      col: op.col,
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  },
  setTableColWidth: async (op: SetTableColWidthOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setTableColWidth(slide, op.sourceId, op.col, toEmu(session, op.fitWidthPx, op.wPx))) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  setTableRowHeight: async (op: SetTableRowHeightOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setTableRowHeight(slide, op.sourceId, op.row, toEmu(session, op.fitWidthPx, op.hPx))) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  setTableCellAnchor: async (op: SetTableCellAnchorOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setTableCellAnchor(slide, op.sourceId, op.row, op.col, op.anchor)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },

  editFill: async (op: EditFillOp) => {
    const session = getWebSession()
    if (!session) return null
    return webEditFill(session, op)
  },

  editStroke: async (op: EditStrokeOp) => {
    const session = getWebSession()
    if (!session) return null
    return webEditStroke(session, op)
  },

  flipElements: async (op: FlipElementOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const targets = op.sourceIds
      .map((id) =>
        op.groupId
          ? findGroupChild(slide, op.groupId, id)?.child
          : slide.elements.find((el) => el.id === id),
      )
      .filter((el): el is NonNullable<typeof el> => !!el)
    if (targets.length === 0) return null
    pushHistory(session)
    for (const el of targets) {
      if (op.axis === 'h') el.transform.flipH = !el.transform.flipH
      else el.transform.flipV = !el.transform.flipV
      if (op.groupId) {
        // Group children: mark the slide structureDirty so the group XML is re-serialized at save
        slide.structureDirty = true
      } else {
        el.dirtyTransform = true
      }
    }
    updateConnectorsForMoved(
      slide,
      targets.map((el) => el.id),
    )
    return rebuildSlide(session, op.slideIndex)
  },

  editBackground: async (op: EditBackgroundOp) => {
    const session = getWebSession()
    if (!session) return null
    return webEditBackground(session, op)
  },

  insertImage: async (slideIndex, fitWidthPx) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    const picked = await pickImageFile()
    if (!picked) return null
    const deckSize = session.opened.deck.size
    const natural = await imageNaturalSize(picked.bytes)
    const maxW = deckSize.cx / 2
    const maxH = deckSize.cy / 2
    const scale = Math.min(maxW / natural.width, maxH / natural.height)
    const cx = Math.max(1, Math.round(natural.width * scale))
    const cy = Math.max(1, Math.round(natural.height * scale))
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: picked.bytes,
      ext: picked.ext,
      offset: {
        x: Math.round((deckSize.cx - cx) / 2),
        y: Math.round((deckSize.cy - cy) / 2),
        cx,
        cy,
      },
    })
    if (!el) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext: picked.ext }
    }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  },
  copyElements: async () => 0,
  pasteElements: async () => null,
  duplicateElements: async () => null,
  addTable: async (op: AddTableOp) => {
    const session = getWebSession()
    if (!session) return null
    if (!session.opened.deck.slides[op.slideIndex]) return null
    pushHistory(session)
    const r = addTable(session.opened, op.slideIndex, {
      rows: op.rows,
      cols: op.cols,
      offset: {
        x: toEmu(session, op.fitWidthPx, op.xPx),
        y: toEmu(session, op.fitWidthPx, op.yPx),
        cx: toEmu(session, op.fitWidthPx, op.wPx),
        cy: toEmu(session, op.fitWidthPx, op.hPx),
      },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  },
  addInk: async () => notAvailable('addInk'),
  addChart: async (op: AddChartOp) => {
    const session = getWebSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    pushHistory(session)
    const r = addChart(session.opened, op.slideIndex, {
      kind: op.kind === 'barH' ? 'bar' : op.kind,
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.title ? { title: op.title } : {}),
      categories: op.categories,
      series: op.series,
      offset: {
        x: toEmu(session, op.fitWidthPx, op.xPx),
        y: toEmu(session, op.fitWidthPx, op.yPx),
        cx: toEmu(session, op.fitWidthPx, op.wPx),
        cy: toEmu(session, op.fitWidthPx, op.hPx),
      },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  },
  addSmartArt: async (op: AddSmartArtOp) => {
    const session = getWebSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    pushHistory(session)
    const r = addSmartArt(session.opened, op.slideIndex, {
      layout: op.layout,
      items: op.items,
      offset: {
        x: toEmu(session, op.fitWidthPx, op.xPx),
        y: toEmu(session, op.fitWidthPx, op.yPx),
        cx: toEmu(session, op.fitWidthPx, op.wPx),
        cy: toEmu(session, op.fitWidthPx, op.hPx),
      },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  },
  addImageBytes: async (op: AddImageBytesOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: base64ToBytes(op.base64),
      ext: op.ext,
      offset: {
        x: toEmu(session, op.fitWidthPx, op.xPx),
        y: toEmu(session, op.fitWidthPx, op.yPx),
        cx: Math.max(1, toEmu(session, op.fitWidthPx, op.wPx)),
        cy: Math.max(1, toEmu(session, op.fitWidthPx, op.hPx)),
      },
      ...(op.name ? { name: op.name } : {}),
    })
    if (!el) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext: op.ext }
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  },
  replacePictureBytes: async (op: ReplacePictureBytesOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    const ok = replacePictureBytes(
      session.opened,
      slide,
      op.sourceId,
      base64ToBytes(op.base64),
      op.ext,
      op.keepSrcRect ? { keepSrcRect: true } : undefined,
    )
    if (!ok) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext: op.ext }
    }
    return rebuildSlide(session, op.slideIndex)
  },
  insertMedia: async () => notAvailable('insertMedia'),
  addMediaBytes: async () => notAvailable('addMediaBytes'),
  getMediaData: async () => notAvailable('getMediaData'),
  insertModel3d: async () => notAvailable('insertModel3d'),
  insertImageUrl: async (op) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const fetched = await fetchImageBytes(op.url)
    if (!fetched) {
      console.error('[web-slides] insertImageUrl: fetch failed for', op.url)
      return null
    }
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: fetched.bytes,
      ext: fetched.ext,
      offset: {
        x: toEmu(session, op.fitWidthPx, op.xPx),
        y: toEmu(session, op.fitWidthPx, op.yPx),
        cx: Math.max(1, toEmu(session, op.fitWidthPx, op.wPx)),
        cy: Math.max(1, toEmu(session, op.fitWidthPx, op.hPx)),
      },
    })
    if (!el) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  },
  replacePictureUrl: async (op) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const fetched = await fetchImageBytes(op.url)
    if (!fetched) {
      console.error('[web-slides] replacePictureUrl: fetch failed for', op.url)
      return null
    }
    pushHistory(session)
    const ok = replacePictureBytes(
      session.opened,
      slide,
      op.sourceId,
      fetched.bytes,
      fetched.ext,
      op.keepSrcRect ? { keepSrcRect: true } : undefined,
    )
    if (!ok) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  },
  setLink: async () => notAvailable('setLink'),
  getLink: async () => notAvailable('getLink'),
  getRunLinks: async () => [],
  getSlideLinks: async () => [],
  getHeaderFooter: async () => notAvailable('getHeaderFooter'),
  applyHeaderFooter: async () => notAvailable('applyHeaderFooter'),

  setNotes: async (op: SetNotesOp) => {
    const session = getWebSession()
    if (!session) return false
    return webSetNotes(session, op.slideIndex, op.text)
  },

  getNotes: async (slideIndex: number) => {
    const session = getWebSession()
    if (!session) return ''
    return webGetNotes(session, slideIndex)
  },

  addComment: async () => null,
  deleteComment: async () => null,
  getComments: async () => [],

  // array-typed stubs must resolve real arrays (the renderer reads .length)
  getSections: async () => {
    console.warn('[web-slides] getSections is not available in the web version (documented subset)')
    return []
  },
  addSection: async () => notAvailable('addSection'),
  renameSection: async () => notAvailable('renameSection'),
  removeSection: async () => notAvailable('removeSection'),
  moveSection: async () => notAvailable('moveSection'),

  getLayouts: async () => notAvailable('getLayouts'),
  getChartColorSchemes: async () => {
    const session = getWebSession()
    return session ? chartColorSchemes(session.opened) : []
  },
  getTransition: async () => 'none' as never,
  setTransition: async () => notAvailable('setTransition'),
  setAdvanceTimes: async () => notAvailable('setAdvanceTimes'),
  getAnimations: async () => {
    console.warn('[web-slides] getAnimations is not available in the web version (documented subset)')
    return []
  },
  setAnimations: async () => notAvailable('setAnimations'),
  getShapeKeys: async () => [],
  getChartData: async (slideIndex, sourceId) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    return getChartElementData(slide, sourceId)
  },
  editChart: async (op: EditChartOp) => {
    const session = getWebSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const elIdx = slide.elements.findIndex((el) => el.id === op.sourceId)
    const chartEl = slide.elements[elIdx] as { type?: string; descr?: string } | undefined
    if (chartEl?.type === 'chart' && chartEl.descr !== 'aislides-chart') {
      const ok = window.confirm(
        'Editing this imported chart will rebuild it from a template and drop unmodeled formatting. Continue?',
      )
      if (!ok) return null
    }
    pushHistory(session)
    markChartEditable(slide, op.sourceId)
    const patch: Parameters<typeof editChartElement>[3] = {
      ...(op.kind ? { kind: op.kind === 'barH' ? 'bar' : op.kind } : {}),
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.categories ? { categories: op.categories } : {}),
      ...(op.series ? { series: op.series } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.colorScheme
        ? {
            colorScheme:
              chartColorSchemes(session.opened).find((s) => s.key === op.colorScheme)?.colors ??
              CHART_COLOR_SCHEMES[op.colorScheme],
          }
        : {}),
      ...(op.legendPos ? { legendPos: op.legendPos } : {}),
      ...(op.dataLabels !== undefined ? { dataLabels: op.dataLabels } : {}),
      ...(op.gridlines !== undefined ? { gridlines: op.gridlines } : {}),
      ...(op.catAxisTitle !== undefined ? { catAxisTitle: op.catAxisTitle } : {}),
      ...(op.valAxisTitle !== undefined ? { valAxisTitle: op.valAxisTitle } : {}),
      ...(op.gapWidthPct !== undefined ? { gapWidthPct: op.gapWidthPct } : {}),
      ...(op.switchRowCol ? { switchRowCol: true } : {}),
      ...(op.pointColors ? { pointColors: op.pointColors } : {}),
    }
    if (!editChartElement(session.opened, op.slideIndex, op.sourceId, patch)) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  },

  saveStyleTemplate: async (name, data) => {
    try {
      const safeName = safeTemplateName(name)
      if (!safeName) return { ok: false, error: 'invalid template name' }
      upsertStyleTemplate({ ...data, name: safeName })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  loadStyleTemplate: async (name) => {
    try {
      const safeName = safeTemplateName(name)
      const found = readStyleTemplates().find((t) => t.name === safeName)
      if (!found) return { ok: false, error: `template not found: ${name}` }
      if (!found.styleSkill) return { ok: false, error: `template has no styleSkill: ${name}` }
      return { ok: true, styleSkill: found.styleSkill, topic: found.topic ?? '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  listStyleTemplates: async () =>
    readStyleTemplates().map((t) => ({
      name: t.name,
      topic: t.topic ?? '',
      createdAt: t.createdAt ?? '',
    })),
  saveStyleSidecar: async (data) => {
    try {
      localStorage.setItem(STYLE_SIDECAR_KEY, JSON.stringify(data))
      // Sidecars are deck-local metadata — do NOT add to the user-visible style template list
      return { ok: true }
    } catch {
      return { ok: false }
    }
  },

  masterOpen: async () => notAvailable('masterOpen'),
  masterEnter: async () => notAvailable('masterEnter'),
  masterClose: async () => null,
  masterEditText: async () => notAvailable('masterEditText'),
  masterEditTransform: async () => notAvailable('masterEditTransform'),
  masterEditFill: async () => notAvailable('masterEditFill'),
  masterEditStroke: async () => notAvailable('masterEditStroke'),
  masterDeleteElement: async () => notAvailable('masterDeleteElement'),

  presenterStart: async () => notAvailable('presenterStart'),
  presenterEnd: async () => notAvailable('presenterEnd'),
  presenterSync: async () => notAvailable('presenterSync'),
  presenterSwap: async () => notAvailable('presenterSwap'),
  presenterInk: async () => notAvailable('presenterInk'),
  audienceNav: async () => notAvailable('audienceNav'),
  audienceReady: async () => notAvailable('audienceReady'),
  onAudienceNav: () => () => {},
  onShowSync: () => () => {},
  onShowInk: () => () => {},

  undo: async () => {
    const session = getWebSession()
    if (!session) return null
    return webUndo(session)
  },

  redo: async () => {
    const session = getWebSession()
    if (!session) return null
    return webRedo(session)
  },

  printSlides: async () => notAvailable('printSlides'),
  exportImages: async () => notAvailable('exportImages'),
  exportPdf: async () => notAvailable('exportPdf'),
  pickExportDir: async () => null,
  pickExportPdfPath: async () => null,

  // ── save (BR-008: bytes via webSaveBytes; write-back is control.ts's job) ──
  save: async () => {
    const session = getWebSession()
    if (!session) return { ok: false, error: 'no file open' }
    try {
      await webSaveBytes(session)
      return {
        ok: true,
        slides: session.opened.deck.slides.map((s, i) =>
          rebuildSlide(session, i),
        ) as unknown as RenderSlide[],
        path: session.path || undefined,
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  saveAs: async (name: string) => {
    const session = getWebSession()
    if (!session) return { ok: false, error: 'no file open' }
    try {
      const bytes = await webSaveBytes(session)
      downloadBytes(bytes, name)
      return { ok: true, path: name }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  isDirty: async () => {
    const session = getWebSession()
    return session ? sessionDirty(session) : false
  },

  setAutoSavePref: async (pref) => {
    autoSavePref = pref
  },

  getRecentFiles: async () => [],

  onOpened: (handler) => {
    openedListeners.add(handler)
    return () => openedListeners.delete(handler)
  },

  onRenamed: (handler) => {
    renamedListeners.add(handler)
    return () => renamedListeners.delete(handler)
  },

  onMenuCommand: (handler) => {
    menuListeners.add(handler)
    return () => menuListeners.delete(handler)
  },

  onCloseSaveRequest: (handler) => {
    closeSaveListeners.add(handler)
    return () => closeSaveListeners.delete(handler)
  },

  reportCloseSaveResult: () => {},

  getAiSettings: async () => readAiSettings(),
  setAiSettings: async (settings) => {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings))
  },

  aiStream: async (request) => {
    void runAiStream(request)
  },
  aiStreamCancel: async (requestId) => {
    activeAiStreams.get(requestId)?.abort()
  },
  aiGskLogin: async () => {
    window.open('https://www.genspark.ai', '_blank', 'noopener')
  },
  aiGskStatus: async () => ({ loggedIn: false }),

  webSearch: async (query, maxResults) => {
    const res = await relay<{ results: Array<{ title: string; url: string; snippet: string }>; method: string; error?: string }>(
      '/search/web',
      { query, maxResults: maxResults ?? 5 },
    )
    if (res) return res
    return { results: [], method: 'error', error: '联网搜索需要本地中继服务（npm run web）' }
  },

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

  generateImage: async (op) => {
    const res = await relay<{ url?: string; error?: string }>(
      '/generate-image',
      {
        prompt: op.prompt,
        model: op.model,
        referenceImageUrls: op.referenceImageUrls,
        aspectRatio: op.aspectRatio,
        imageSize: op.imageSize,
      },
      600_000,
    )
    if (!res) return { error: '图片生成需要本地中继服务（npm run web）且已登录 Genspark' }
    return res
  },
  analyzeMedia: async (op) => {
    const res = await relay<{ text?: string; error?: string }>(
      '/analyze-media',
      { mediaUrls: op.mediaUrls, requirements: op.requirements },
      600_000,
    )
    if (!res) return { error: '媒体分析需要本地中继服务（npm run web）且已登录 Genspark' }
    return res
  },

  onAiStream: (handler) => {
    aiStreamListeners.add(handler)
    return () => aiStreamListeners.delete(handler)
  },
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** control-mode write-back payload (BR-008): CURRENT deck bytes. */
export async function exportSlidesBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const session = getWebSession()
  if (!session) return null
  const bytes = await webSaveBytes(session)
  return { bytes, name: session.path.split('/').pop() ?? 'presentation.pptx' }
}

window.__genofficeExportBytes = exportSlidesBytes

// ── window.desktop (DesktopFilesApi — chat attachments, minimal) ────────

const desktopFiles: DesktopFilesApi = {
  pickAttachments: async () => null,
  addAttachmentPaths: async (paths: string[]) => ({
    accepted: [],
    rejected: paths.map((p: string) => `找不到附件: ${p}`),
  }),
  addPastedImage: async () => ({
    accepted: [],
    rejected: ['网页版暂不支持粘贴图片附件'],
  }),
  readAttachment: async () => ({ ok: false, error: '附件不可用' }),
  readAttachmentImage: async () => ({ ok: false, error: '附件不可用' }),
  getPathForFile: () => `/webdoc/${crypto.randomUUID()}/dropped-file`,
}

// ── install ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  ;(window as unknown as { slidesApi: SlidesApi }).slidesApi = slidesApi
  ;(window as unknown as { desktop: DesktopFilesApi }).desktop = desktopFiles
}

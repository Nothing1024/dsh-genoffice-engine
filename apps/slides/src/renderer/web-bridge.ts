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
 *     clipboard, animations, comments, media/links/header-footer
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
  AddMediaBytesOp,
  AddTableOp,
  ApplyEditScriptOp,
  ExportImagesOp,
  ExportPdfOp,
  PrintSlidesOp,
  HeaderFooterOp,
  AnimationItem,
  ApplyThemeOp,
  MasterDeleteElementOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  SetAdvanceTimesOp,
  SetAnimationsOp,
  SetTransitionOp,
  ApplyTxnOp,
  ApplyTxnResult,
  AddSectionOp,
  BatchEditTransformOp,
  FindReplaceOp,
  MoveSectionOp,
  MoveSlideOp,
  RemoveSectionOp,
  RenameSectionOp,
  SetSlideHiddenOp,
  SetSlideLayoutOp,
  SetLinkOp,
  SetSlideSizeOp,
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
  AutoSaveDefault,
  SlidesApi,
  TableMergeIpcOp,
  TableStructureIpcOp,
  UngroupElementOp,
  UiTheme,
} from '../shared/ipc'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
// The barrel, not ./ops/executor: importing the executor alone leaves the op
// registry empty, and every transaction fails with `unknown op`.
import { runTxn } from '../main/ops'
import { mapScriptOps } from '../main/ops/script-map'
import { buildRenderSlide, HeuristicMetrics, type RenderSlide } from '@genoffice/pptx-render'
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
  getElementLink,
  getRunLinks,
  getSlideLinks,
  getSlideAnimations,
  getSlideTransition,
  elementSpid,
  listMasterParts,
  parseMasterPart,
  getSections,
  readHeaderFooter,
  reparseDeck,
  listSlideLayouts,
  shouldOfferBuiltinLayouts,
  builtinLayoutInfos,
  ensureBuiltinLayout,
  BUILTIN_LAYOUT_PREFIX,
  type OpenedPptx,
  type SectionInfo,
  type Slide,
  type Paragraph,
  type TableStructureOp,
  type TableStyleEdit,
} from '@genoffice/pptx-engine'
import { elementDurableId, matchesElementRef } from '@genoffice/pptx-engine/identity'
import {
  beginHistoryBatch,
  EMU_PER_PT,
  EMU_PER_PX_96,
  endHistoryBatch,
  getWebSession,
  buildAllRenderSlides,
  makeMediaResolver,
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

async function openPath(path: string, fitWidthPx: number): Promise<OpenResult> {
  const res = await relay<{ ok: boolean; base64?: string; name?: string; error?: string }>(
    `/file?path=${encodeURIComponent(path)}`,
  )
  if (!res?.ok || !res.base64) throw new Error(`load-error: ${res?.error ?? 'empty result for path target'}`)
  const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))
  const result = await webOpenBytes(bin, path, fitWidthPx)
  clearOpenTarget()
  return result
}

async function openAnyTarget(target: string, fitWidthPx: number): Promise<OpenResult> {
  if (target.startsWith('path:')) return openPath(target.slice('path:'.length), fitWidthPx)
  if (target.startsWith('/webdoc/')) {
    const fetched = await bytesFromWebdoc(target)
    const result = await webOpenBytes(fetched.bytes, target, fitWidthPx)
    clearOpenTarget()
    return result
  }
  throw new Error(`load-error: unsupported open target`)
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

// ── explicit not-available stub (防呆: never silent) ────────────────────

function notAvailable(method: string): Promise<never> {
  console.warn(`[web-slides] ${method} is not available in the web version (documented subset)`)
  return Promise.resolve(null as never)
}

type TxnOp = Parameters<typeof runTxn>[1]['ops'][number]

function webTxn(ops: TxnOp[], parts?: Map<string, Slide>) {
  const session = getWebSession()
  if (!session) return null
  const extra = parts ? { parts } : {}
  const plan = runTxn(session.opened, { ops, dryRun: true, ...extra })
  if (plan.failures?.length) return { session, r: plan, failed: true as const }
  pushHistory(session)
  const r = runTxn(session.opened, { ops, ...extra })
  if (!r.applied) {
    session.undoStack.pop()
    return { session, r, failed: true as const }
  }
  return { session, r, failed: false as const }
}

function buildMasterRender(session: WebSlideSession) {
  const me = session.masterEdit
  if (!me) return null
  return buildRenderSlide(me.slide, session.opened.deck.size, {
    fitWidthPx: session.fitWidthPx,
    media: makeMediaResolver(session.opened),
    metrics: new HeuristicMetrics(),
  })
}

function masterTxn(op: TxnOp) {
  const session = getWebSession()
  const me = session?.masterEdit
  if (!session || !me) return null
  return webTxn([op], new Map([[me.partPath, me.slide]]))
}

function readAnimations(session: WebSlideSession, slideIndex: number): AnimationItem[] {
  const slide = session.opened.deck.slides[slideIndex]
  if (!slide) return []
  const bySpid = new Map<number, (typeof slide.elements)[number]>()
  for (const el of slide.elements) {
    const spid = elementSpid(el)
    if (spid != null && !bySpid.has(spid)) bySpid.set(spid, el)
  }
  const out: AnimationItem[] = []
  for (const a of getSlideAnimations(slide)) {
    const el = bySpid.get(a.spid)
    if (!el) continue
    out.push({
      sourceId: el.id,
      targetName: el.name || el.type,
      effect: a.effect,
      trigger: a.trigger,
      durationMs: a.durationMs,
      delayMs: a.delayMs,
      ...(a.motionPath != null ? { motionPath: a.motionPath } : {}),
      ...(a.paragraph != null ? { paragraph: a.paragraph } : {}),
    })
  }
  return out
}

function resolveLayoutPath(layoutPath?: string): string | undefined {
  const session = getWebSession()
  if (!session || !layoutPath) return layoutPath
  if (!layoutPath.startsWith(BUILTIN_LAYOUT_PREFIX)) return layoutPath
  return (
    ensureBuiltinLayout(
      session.opened.archive,
      session.opened.deck.size,
      layoutPath.slice(BUILTIN_LAYOUT_PREFIX.length),
    ) ?? undefined
  )
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

const AV_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
}

function mediaOffset(session: NonNullable<ReturnType<typeof getWebSession>>) {
  const deckSize = session.opened.deck.size
  const cx = Math.round(deckSize.cx * 0.6)
  const cy = Math.round((cx * 9) / 16)
  return {
    x: Math.round((deckSize.cx - cx) / 2),
    y: Math.round((deckSize.cy - cy) / 2),
    cx,
    cy,
  }
}

async function pickMediaFile(kind: 'video' | 'audio'): Promise<{ bytes: Uint8Array; ext: string; name: string } | null> {
  const accept =
    kind === 'video'
      ? { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.avi'] }
      : { 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg'] }
  try {
    if (typeof window.showOpenFilePicker === 'function') {
      const handles = (await window.showOpenFilePicker({
        types: [{ description: kind, accept }],
        multiple: false,
      })) as FileSystemFileHandle[]
      const file = await handles[0]?.getFile()
      if (!file) return null
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        ext: (file.name.split('.').pop() ?? (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase(),
        name: file.name,
      }
    }
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return null
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg'
    input.onchange = async () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      resolve({
        bytes: new Uint8Array(await file.arrayBuffer()),
        ext: (file.name.split('.').pop() ?? (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase(),
        name: file.name,
      })
    }
    input.oncancel = () => {
      input.remove()
      resolve(null)
    }
    input.click()
  })
}

function addMediaFromBytes(
  slideIndex: number,
  kind: 'video' | 'audio',
  bytes: Uint8Array,
  ext: string,
  fitWidthPx: number,
  name?: string,
) {
  const session = getWebSession()
  if (!session || !session.opened.deck.slides[slideIndex]) return null
  const txn = webTxn([
    {
      op: 'addMedia',
      target: { slide: slideIndex },
      kind,
      bytes,
      ext,
      offset: mediaOffset(session),
      ...(name ? { name } : {}),
    },
  ])
  if (!txn || txn.failed) return null
  txn.session.fitWidthPx = fitWidthPx
  const rebuilt = rebuildSlide(txn.session, slideIndex)
  const created = txn.r.records?.[0]?.created?.[0]
  const el = created
    ? txn.session.opened.deck.slides[slideIndex]?.elements.find((item) =>
        matchesElementRef(item, created),
      )
    : undefined
  const sourceId = (el && elementDurableId(el)) || created
  return rebuilt && sourceId ? { slide: rebuilt, sourceId } : null
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
  getAutoSaveDefault: async (): Promise<AutoSaveDefault> => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: () => () => {},
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: () => () => {},
  onChromePressed: () => () => {},
  setShowFullScreen: async (on: boolean) => {
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen()
      if (!on && document.fullscreenElement) await document.exitFullscreen()
    } catch (e) {
      console.warn('[web-slides] setShowFullScreen denied', e)
    }
  },
  privateFontFaces: async () => [],
  privateFontData: async () => null,
  fontCatalog: async () => [],
  fontDownload: async () => ({ ok: false, error: '网页版不提供字体下载' }),
  fontInstallLocal: async () => ({ families: [] }),
  fontMissing: async () => [],
  onFontsChanged: () => () => {},

  openPptx: async (fitWidthPx) => {
    const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
    if (target) return openAnyTarget(target, fitWidthPx)
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
    const target = parseOpenTarget() ?? INITIAL_OPEN_TARGET
    if (!target) return null
    return openAnyTarget(target, fitWidthPx)
  },

  newBlank: async (fitWidthPx) => webNewBlank(fitWidthPx),

  landGeneratedPages: async () => ({
    error: '网页版请使用 htmlToPptx / generateFromHtml 落页',
  }),
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

  findReplace: async (op: FindReplaceOp) => {
    const txn = webTxn([
      {
        op: 'findReplace',
        find: op.find,
        replace: op.replace,
        matchCase: op.matchCase,
        firstOnly: op.firstOnly,
        slideIndex: op.slideIndex,
        elementId: op.elementId,
      },
    ])
    if (!txn || txn.failed) return { count: 0, slides: null }
    const count = (txn.r.records?.[0]?.after as { count?: number } | undefined)?.count ?? 0
    return { count, slides: buildAllRenderSlides(txn.session.opened, txn.session.fitWidthPx) }
  },

  setSlideLayout: async (op: SetSlideLayoutOp) => {
    const layoutPath = resolveLayoutPath(op.layoutPath)
    if (op.layoutPath && !layoutPath) return null
    const txn = webTxn([
      {
        op: 'setSlideLayout',
        target: { slide: op.slideIndex },
        ...(layoutPath ? { layoutPath } : {}),
      },
    ])
    if (!txn || txn.failed) return null
    return rebuildSlide(txn.session, op.slideIndex)
  },
  setSlideSize: async (op: SetSlideSizeOp) => {
    const txn = webTxn([{ op: 'setSlideSize', cx: op.cx, cy: op.cy }])
    if (!txn || txn.failed) return null
    return buildAllRenderSlides(txn.session.opened, txn.session.fitWidthPx)
  },
  getSlideSize: async () => {
    const session = getWebSession()
    if (!session) return null
    return { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy }
  },

  applyTheme: async (op: ApplyThemeOp) => {
    const payload = {
      op: 'applyTheme' as const,
      name: op.name,
      colors: op.colors,
      ...(op.majorFont ? { majorFont: op.majorFont } : {}),
      ...(op.minorFont ? { minorFont: op.minorFont } : {}),
    }
    const txn = webTxn([payload])
    if (!txn) return null
    if (txn.failed) return { error: txn.r.failures?.[0]?.error ?? 'applyTheme failed' }
    const after = txn.r.records?.[0]?.after as { patched?: number; remapped?: number } | undefined
    if ((after?.patched ?? 0) === 0 && (after?.remapped ?? 0) === 0) {
      txn.session.undoStack.pop()
      return null
    }
    txn.session.opened = reparseDeck(txn.session.opened)
    txn.session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(txn.session.opened, op.fitWidthPx)
  },
  setSlideHidden: async (op: SetSlideHiddenOp) => {
    const txn = webTxn([{ op: 'setHidden', target: { slide: op.slideIndex }, hidden: op.hidden }])
    if (!txn || txn.failed) return null
    return rebuildSlide(txn.session, op.slideIndex)
  },
  setSections: async (sections: SectionInfo[]) => {
    const txn = webTxn([{ op: 'setSections', sections }])
    if (!txn || txn.failed) return null
    return getSections(txn.session.opened)
  },
  moveSlide: async (op: MoveSlideOp) => {
    const txn = webTxn([{ op: 'moveSlide', target: { slide: op.fromIndex }, to: op.toIndex }])
    if (!txn || txn.failed) return null
    return {
      slides: buildAllRenderSlides(txn.session.opened, txn.session.fitWidthPx),
      sections: getSections(txn.session.opened),
    }
  },
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
  // Mirrors the Electron `slides:apply-edit-script` handler: the script's collected
  // primitives compile to ops (script-map) and apply as one transaction. Autofit
  // write-back is a main-process render concern the web session does not model.
  applyEditScript: async (req: ApplyEditScriptOp) => {
    const session = getWebSession()
    if (!session) return null
    const ops = mapScriptOps(session.opened, req)
    if (ops.length === 0) return null
    const plan = runTxn(session.opened, { ops, dryRun: true })
    if (plan.failures?.length) return { error: plan.failures[0]!.error }
    pushHistory(session)
    const r = runTxn(session.opened, { ops })
    if (!r.applied) {
      session.undoStack.pop()
      return { error: r.failures?.[0]?.error ?? 'the transaction could not be applied' }
    }
    const rendered = rebuildSlide(session, req.slideIndex)
    return rendered ? { slide: rendered } : null
  },
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
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId))
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
      const el = slide.elements.find((x) => matchesElementRef(x, op.sourceId))
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
  clipboardProbe: async () => false,
  pickPictureFile: async () => null,
  setEffects: async () => {
    console.warn('[web-slides] setEffects is not available in the web version')
    return null
  },
  setTextBodyProps: async () => {
    console.warn('[web-slides] setTextBodyProps is not available in the web version')
    return null
  },
  onDeckChanged: () => () => {},
  aiLogRunFailure: async () => {},

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
          : slide.elements.find((el) => matchesElementRef(el, id)),
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
  insertMedia: async (slideIndex: number, kind: 'video' | 'audio', fitWidthPx: number) => {
    const picked = await pickMediaFile(kind)
    if (!picked) return null
    return addMediaFromBytes(slideIndex, kind, picked.bytes, picked.ext, fitWidthPx, picked.name)
  },
  addMediaBytes: async (op: AddMediaBytesOp) =>
    addMediaFromBytes(
      op.slideIndex,
      op.kind,
      base64ToBytes(op.base64),
      op.ext,
      op.fitWidthPx,
      op.name,
    ),
  getMediaData: async (slideIndex: number, sourceId: string) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[slideIndex]
    if (!session || !slide) return null
    const el = slide.elements.find((item) => matchesElementRef(item, sourceId))
    if (!el || el.type !== 'picture') return null
    const media = (
      el as { media?: { kind: 'video' | 'audio'; target?: string; external?: boolean } }
    ).media
    if (!media?.target) return null
    if (media.external) return { kind: media.kind, dataUrl: media.target }
    const bytes = session.opened.archive.readBytes(media.target)
    if (!bytes) return null
    const ext = media.target.split('.').pop()?.toLowerCase() ?? ''
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return { kind: media.kind, dataUrl: `data:${mime};base64,${btoa(bin)}` }
  },
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
  setLink: async (op: SetLinkOp) => {
    const txn = webTxn([
      { op: 'setLink', target: { slide: op.slideIndex, el: op.sourceId }, link: op.target },
    ])
    if (!txn || txn.failed) return null
    return rebuildSlide(txn.session, op.slideIndex)
  },
  getLink: async (slideIndex: number, sourceId: string) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[slideIndex]
    const el = slide?.elements.find((item) => matchesElementRef(item, sourceId))
    if (!session || !el) return null
    return getElementLink(session.opened, slideIndex, el.id)
  },
  getRunLinks: async (slideIndex: number) => {
    const session = getWebSession()
    if (!session) return []
    return getRunLinks(session.opened, slideIndex).map(({ elementId, ...rest }) => ({
      sourceId: elementId,
      ...rest,
    }))
  },
  getSlideLinks: async (slideIndex: number) => {
    const session = getWebSession()
    if (!session) return []
    return getSlideLinks(session.opened, slideIndex).map(({ elementId, target }) => ({
      sourceId: elementId,
      target,
    }))
  },
  getHeaderFooter: async (slideIndex: number) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null }
  },
  applyHeaderFooter: async (op: HeaderFooterOp) => {
    const txn = webTxn([
      {
        op: 'applyHeaderFooter',
        settings: {
          footer: op.footer ?? null,
          slideNum: !!op.slideNum,
          date: op.date ?? null,
          ...(op.dateAuto ? { dateAuto: true } : {}),
        },
      },
    ])
    if (!txn || txn.failed) return null
    txn.session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(txn.session.opened, op.fitWidthPx)
  },

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
    const session = getWebSession()
    return session ? getSections(session.opened) : []
  },
  addSection: async (op: AddSectionOp) => {
    const txn = webTxn([{ op: 'addSection', atSlideIndex: op.atSlideIndex, name: op.name }])
    if (!txn || txn.failed) return null
    return (txn.r.records?.[0]?.after as SectionInfo[] | undefined) ?? getSections(txn.session.opened)
  },
  renameSection: async (op: RenameSectionOp) => {
    const txn = webTxn([{ op: 'renameSection', id: op.id, name: op.name }])
    if (!txn || txn.failed) return null
    return (txn.r.records?.[0]?.after as SectionInfo[] | undefined) ?? getSections(txn.session.opened)
  },
  removeSection: async (op: RemoveSectionOp) => {
    const txn = webTxn([{ op: 'removeSection', id: op.id }])
    if (!txn || txn.failed) return null
    return (txn.r.records?.[0]?.after as SectionInfo[] | undefined) ?? getSections(txn.session.opened)
  },
  moveSection: async (op: MoveSectionOp) => {
    const txn = webTxn([{ op: 'moveSection', id: op.id, dir: op.dir }])
    if (!txn || txn.failed) return null
    return {
      slides: buildAllRenderSlides(txn.session.opened, txn.session.fitWidthPx),
      sections: getSections(txn.session.opened),
    }
  },

  getLayouts: async () => {
    const session = getWebSession()
    if (!session) return null
    const layouts = listSlideLayouts(session.opened.archive)
    if (shouldOfferBuiltinLayouts(layouts)) {
      layouts.push(
        ...builtinLayoutInfos(session.opened.deck.size, new Set(layouts.map((item) => item.name))),
      )
    }
    return { layouts, size: { ...session.opened.deck.size } }
  },
  getChartColorSchemes: async () => {
    const session = getWebSession()
    return session ? chartColorSchemes(session.opened) : []
  },
  getTransition: async (slideIndex: number) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? getSlideTransition(slide) : 'none'
  },
  setTransition: async (op: SetTransitionOp) => {
    const session = getWebSession()
    if (!session) return false
    const slides = session.opened.deck.slides
    const idxs =
      op.slideIndex === -1 ? slides.map((_, i) => i) : slides[op.slideIndex] ? [op.slideIndex] : []
    if (idxs.length === 0) return false
    const txn = webTxn(idxs.map((i) => ({ op: 'setTransition', target: { slide: i }, kind: op.kind })))
    return Boolean(txn && !txn.failed)
  },
  setAdvanceTimes: async (op: SetAdvanceTimesOp) => {
    const session = getWebSession()
    if (!session) return false
    const slides = session.opened.deck.slides
    const targets = op.times.filter((t) => slides[t.slideIndex])
    if (targets.length === 0) return false
    const txn = webTxn(
      targets.map((t) => ({ op: 'setAdvanceTime', target: { slide: t.slideIndex }, ms: t.ms })),
    )
    return Boolean(txn && !txn.failed)
  },
  getAnimations: async (slideIndex: number) => {
    const session = getWebSession()
    return session ? readAnimations(session, slideIndex) : []
  },
  setAnimations: async (op: SetAnimationsOp) => {
    const txn = webTxn([{ op: 'setAnimations', target: { slide: op.slideIndex }, items: op.items }])
    return Boolean(txn && !txn.failed)
  },
  getShapeKeys: async (slideIndex: number) => {
    const session = getWebSession()
    const slide = session?.opened.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }))
  },
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
    const elIdx = slide.elements.findIndex((el) => matchesElementRef(el, op.sourceId))
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

  masterEnter: async (fitWidthPx: number) => {
    const session = getWebSession()
    if (!session) return null
    session.fitWidthPx = fitWidthPx
    const items = []
    for (const part of listMasterParts(session.opened.archive)) {
      const slide = parseMasterPart(session.opened.archive, part.partPath)
      if (!slide) continue
      const rendered = buildRenderSlide(slide, session.opened.deck.size, {
        fitWidthPx,
        media: makeMediaResolver(session.opened),
        metrics: new HeuristicMetrics(),
      })
      items.push({ partPath: part.partPath, kind: part.kind, name: part.name, slide: rendered })
      if (!session.masterEdit) session.masterEdit = { partPath: part.partPath, slide }
    }
    return items.length ? { items } : null
  },
  masterOpen: async (partPath: string) => {
    const session = getWebSession()
    if (!session) return null
    const slide = parseMasterPart(session.opened.archive, partPath)
    if (!slide) return null
    session.masterEdit = { partPath, slide }
    return buildMasterRender(session)
  },
  masterClose: async () => {
    const session = getWebSession()
    if (!session) return null
    session.masterEdit = null
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  },
  masterEditText: async (op: MasterEditTextOp) => {
    const session = getWebSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const txn = masterTxn({
      op: 'setText',
      target: { part: me.partPath, el: op.sourceId },
      paragraphs: op.paragraphs,
    })
    return txn && !txn.failed ? buildMasterRender(session) : null
  },
  masterEditTransform: async (op: MasterEditTransformOp) => {
    const session = getWebSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = me.slide.elements.find((item) => matchesElementRef(item, op.sourceId))
    if (!el) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    if (op.preview) {
      el.transform = {
        ...el.transform,
        offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        rot: Math.round(op.rotationDeg * 60000),
      }
      return buildMasterRender(session)
    }
    const txn = masterTxn({
      op: 'setTransform',
      target: { part: me.partPath, el: op.sourceId },
      box: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      rotDeg: op.rotationDeg,
    })
    return txn && !txn.failed ? buildMasterRender(session) : null
  },
  masterEditFill: async (op: MasterEditFillOp) => {
    const session = getWebSession()
    if (!session?.masterEdit) return null
    const txn = masterTxn({
      op: 'setFill',
      target: { part: session.masterEdit.partPath, el: op.sourceId },
      fill: op.fill,
    })
    return txn && !txn.failed ? buildMasterRender(session) : null
  },
  masterEditStroke: async (op: MasterEditStrokeOp) => {
    const session = getWebSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const txn = masterTxn({
      op: 'setStroke',
      target: { part: me.partPath, el: op.sourceId },
      stroke: op.stroke
        ? { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) }
        : null,
    })
    return txn && !txn.failed ? buildMasterRender(session) : null
  },
  masterDeleteElement: async (op: MasterDeleteElementOp) => {
    const session = getWebSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const txn = masterTxn({
      op: 'deleteElement',
      target: { part: me.partPath, el: op.sourceId },
    })
    return txn && !txn.failed ? buildMasterRender(session) : null
  },

  presenterStart: async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
      return { audience: false }
    } catch (e) {
      console.warn('[web-slides] presenterStart fullscreen denied', e)
      return { audience: false }
    }
  },
  presenterEnd: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
    } catch {
      /* ignore */
    }
  },
  presenterSync: () => {},
  presenterSwap: async () => false,
  presenterInk: () => {},
  audienceNav: () => {},
  audienceReady: async () => null,
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

  printSlides: async (op: PrintSlidesOp) => {
    const ready = await relay<{ available?: boolean; reason?: string }>('/print/ready')
    if (!ready?.available) return { ok: false, error: ready?.reason ?? 'print-service-unavailable' }
    if (!op || !Array.isArray(op.pngsBase64) || op.pngsBase64.length === 0) {
      return { ok: false, error: 'printSlides needs png pages' }
    }
    const printed = await runPrintJob({
      app: 'slides',
      pngsBase64: op.pngsBase64,
      widthPx: op.widthPx,
      heightPx: op.heightPx,
      returnBytes: true,
    })
    return printed.ok ? { ok: true } : { ok: false, error: printed.error ?? 'print-failed' }
  },
  exportImages: async (op: ExportImagesOp) => {
    if (!op.dir || !op.dir.startsWith('/') || !Array.isArray(op.pngsBase64) || op.pngsBase64.length === 0) {
      return { ok: false, error: 'exportImages needs an absolute dir and at least one PNG' }
    }
    const pad = op.pngsBase64.length >= 100 ? 3 : 2
    const paths: string[] = []
    for (let i = 0; i < op.pngsBase64.length; i++) {
      const dest = `${op.dir.replace(/\/$/, '')}/${op.baseName}-${String(i + 1).padStart(pad, '0')}.png`
      const written = await relay<{ ok?: boolean; error?: string; path?: string }>('/file', {
        path: dest,
        base64: op.pngsBase64[i],
        overwrite: true,
      })
      if (!written?.ok) return { ok: false, error: written?.error ?? `failed to write ${dest}` }
      paths.push(written.path ?? dest)
    }
    return { ok: true, paths }
  },
  exportPdf: async (op: ExportPdfOp) => {
    if (!op?.filePath || !op.filePath.startsWith('/') || !Array.isArray(op.pngsBase64) || op.pngsBase64.length === 0) {
      return { ok: false, error: 'exportPdf needs an absolute filePath and at least one PNG' }
    }
    const printed = await runPrintJob({
      app: 'slides',
      dest: op.filePath,
      pngsBase64: op.pngsBase64,
      widthPx: op.widthPx,
      heightPx: op.heightPx,
    })
    return printed.ok
      ? { ok: true, path: printed.path ?? op.filePath }
      : { ok: false, error: printed.error ?? 'print-failed' }
  },
  pickExportDir: async () => null,
  pickExportPdfPath: async (defaultName: string) => {
    const session = getWebSession()
    if (!session?.path || !session.path.startsWith('/')) return null
    const dir = session.path.replace(/\/[^/]+$/, '')
    const name = defaultName.endsWith('.pdf') ? defaultName : `${defaultName}.pdf`
    return `${dir}/${name}`
  },

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

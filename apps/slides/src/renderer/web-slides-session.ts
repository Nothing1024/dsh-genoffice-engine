/**
 * Browser-side slides session model (genoffice-dsh-office, web build only).
 *
 * Port of the Electron main-process session (apps/slides/src/main/session-state.ts
 * + the slides:edit-* handlers of slides-main.ts) onto @genoffice/pptx-engine +
 * @genoffice/pptx-render, which are pure TS and bundle into the browser
 * (the only node builtins — node:crypto/node:zlib — are aliased to
 * web-node-shims.ts by vite.web.config.ts).
 *
 * Scope per the P0 strategy (evidence/phase-0/web-strategy.md): the core
 * editing subset — open/save, text/transform/fill/stroke/background edits,
 * element add/delete, slide add/delete, history (snapshot undo/redo), notes,
 * render-tree rebuilds. Everything else the renderer calls is answered by
 * web-bridge.ts's explicit "not available" stubs.
 */
// MUST precede every other import: installs globalThis.Buffer before JSZip
// evaluates its `support.nodebuffer` check.
import './web-node-shims'
import {
  addElement,
  commitSaved,
  createBlankPptx,
  deleteSlide as deleteSlideFromDeck,
  duplicateSlide,
  editGroupChildFill,
  editGroupChildStroke,
  editGroupChildTransform,
  ensureRunLinkRels,
  findGroupChild,
  getSlideNotes,
  insertBlankSlide,
  materializeSlide,
  openPptx,
  patchGroupChildText,
  reorderElement,
  savePptx,
  setElementFont,
  setElementParagraphFormat,
  setGroupChildParagraphFormat,
  setSlideBackground,
  setSlideNotes,
  updateConnectorsForMoved,
  type OpenedPptx,
  type Paragraph,
  type ParagraphFormatPatch,
  type Slide,
  type TextElement,
} from '@genoffice/pptx-engine'
import {
  buildRenderSlide,
  HeuristicMetrics,
  type RenderSlide,
} from '@genoffice/pptx-render'
import {
  applyEditParagraphs,
  collectParagraphFormatPatches,
  levelsChanged,
} from '../main/edit-text'
import type {
  AddElementOp,
  BatchEditTransformOp,
  EditBackgroundOp,
  EditFillOp,
  EditStrokeOp,
  EditTextOp,
  EditTransformOp,
  OpenResult,
} from '../shared/ipc'

// ── constants / converters (mirror slides-main.ts) ──────────────────────

export const EMU_PER_PX_96 = 9525
export const EMU_PER_PT = 12700

export interface WebSlideSession {
  path: string
  opened: OpenedPptx
  fitWidthPx: number
  undoStack: WebHistorySnapshot[]
  redoStack: WebHistorySnapshot[]
  historyBatch?: { depth: number; undoStart: number }
}

export interface WebHistorySnapshot {
  slides: Slide[]
  entries: Map<string, Uint8Array>
  size: { cx: number; cy: number }
}

const MAX_HISTORY = 50

function trimHistory(stack: WebHistorySnapshot[]): void {
  while (stack.length > MAX_HISTORY) stack.shift()
}

function takeSnapshot(session: WebSlideSession): WebHistorySnapshot {
  return {
    slides: structuredClone(session.opened.deck.slides),
    entries: new Map(session.opened.archive.entries),
    size: { ...session.opened.deck.size },
  }
}

export function restoreSnapshot(
  session: WebSlideSession,
  snapshot: WebHistorySnapshot,
): void {
  // Clone: the live deck mutates elements in place, so handing a snapshot's
  // own arrays over would let later edits rewrite history still referenced by
  // the other stack (mirror of the desktop session-state.ts).
  const fresh = structuredClone(snapshot)
  session.opened.deck.slides = fresh.slides
  session.opened.deck.size = fresh.size
  const entries = session.opened.archive.entries
  entries.clear()
  for (const [k, v] of fresh.entries) entries.set(k, v)
}

export function pushHistory(session: WebSlideSession): void {
  session.undoStack.push(takeSnapshot(session))
  trimHistory(session.undoStack)
  session.redoStack = []
}

/** Undo one snapshot; returns the rebuilt slides or null at the bottom. */
export function webUndo(session: WebSlideSession): RenderSlide[] | null {
  const snapshot = session.undoStack.pop()
  if (!snapshot) return null
  session.redoStack.push(takeSnapshot(session))
  restoreSnapshot(session, snapshot)
  return buildAllRenderSlides(session.opened, session.fitWidthPx)
}

/** Redo one snapshot; returns the rebuilt slides or null at the frontier. */
export function webRedo(session: WebSlideSession): RenderSlide[] | null {
  const snapshot = session.redoStack.pop()
  if (!snapshot) return null
  session.undoStack.push(takeSnapshot(session))
  restoreSnapshot(session, snapshot)
  return buildAllRenderSlides(session.opened, session.fitWidthPx)
}

/** Collapse the current batch into one undo step (begin/end pair). */
export function beginHistoryBatch(session: WebSlideSession): void {
  if (session.historyBatch) {
    session.historyBatch.depth += 1
    return
  }
  session.historyBatch = { depth: 1, undoStart: session.undoStack.length }
}

export function endHistoryBatch(session: WebSlideSession): void {
  const batch = session.historyBatch
  if (!batch) return
  batch.depth -= 1
  if (batch.depth > 0) return
  session.historyBatch = undefined
  // collapse: keep a single pre-transaction snapshot at undoStart
  while (session.undoStack.length > batch.undoStart + 1) {
    session.undoStack.splice(batch.undoStart, 1)
  }
}

/** deck dirty: any history snapshot pending (mirror of desktop isDirty). */
export function sessionDirty(session: WebSlideSession): boolean {
  return session.undoStack.length > 0
}

// ── media resolver (archive entry → dataUrl) ────────────────────────────

const DISPLAY_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function makeMediaResolver(opened: OpenedPptx) {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    const bytes = opened.archive.readBytes(mediaRef)
    let url: string | undefined
    if (bytes) {
      const ext = mediaRef.split('.').pop()?.toLowerCase() ?? 'png'
      if (ext === 'tif' || ext === 'tiff') {
        // TIFF is transcoded to PNG on desktop; browsers cannot decode it —
        // the element renders without its image (documented web limitation)
        url = undefined
      } else {
        const mime = DISPLAY_MIME[ext] ?? 'application/octet-stream'
        url = `data:${mime};base64,${bytesToBase64(bytes)}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}

// ── render-tree rebuilds ────────────────────────────────────────────────

export function buildAllRenderSlides(
  opened: OpenedPptx,
  fitWidthPx: number,
): RenderSlide[] {
  return opened.deck.slides.map((s, i) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeMediaResolver(opened),
      metrics: new HeuristicMetrics(),
      slideNo: i + 1,
    }),
  )
}

export function rebuildSlide(
  session: WebSlideSession,
  slideIndex: number,
): RenderSlide | null {
  const slide = session.opened.deck.slides[slideIndex]
  if (!slide) return null
  return buildRenderSlide(slide, session.opened.deck.size, {
    fitWidthPx: session.fitWidthPx,
    media: makeMediaResolver(session.opened),
    metrics: new HeuristicMetrics(),
    slideNo: slideIndex + 1,
  })
}

/** Reparse then rebuild (table-style / chart edits stale the in-memory model). */
export function rebuildSlideWithReparse(
  session: WebSlideSession,
  slideIndex: number,
): RenderSlide | null {
  const fresh = materializeSlide(session.opened, slideIndex)
  if (!fresh) return null
  return buildRenderSlide(fresh, session.opened.deck.size, {
    fitWidthPx: session.fitWidthPx,
    media: makeMediaResolver(session.opened),
    metrics: new HeuristicMetrics(),
    slideNo: slideIndex + 1,
  })
}

// ── element lookup ──────────────────────────────────────────────────────

function findEl(slide: Slide, sourceId: string): TextElement | undefined {
  const el = slide.elements.find((e) => e.id === sourceId)
  if (el && (el.type === 'text' || el.type === 'shape')) return el as TextElement
  return undefined
}

// ── open / save ─────────────────────────────────────────────────────────

export async function webOpenBytes(
  bytes: Uint8Array,
  path: string,
  fitWidthPx: number,
): Promise<OpenResult> {
  const opened = await openPptx(bytes)
  const session: WebSlideSession = {
    path,
    opened,
    fitWidthPx,
    undoStack: [],
    redoStack: [],
  }
  currentSession = session
  return {
    path,
    slides: buildAllRenderSlides(opened, fitWidthPx),
    size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
  }
}

export async function webNewBlank(fitWidthPx: number): Promise<OpenResult> {
  const opened = await openPptx(await createBlankPptx())
  const session: WebSlideSession = {
    path: '',
    opened,
    fitWidthPx,
    undoStack: [],
    redoStack: [],
  }
  currentSession = session
  return {
    path: '',
    slides: buildAllRenderSlides(opened, fitWidthPx),
    size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
  }
}

/** Serialize the CURRENT deck to pptx bytes (BR-008: the only write payload). */
export async function webSaveBytes(session: WebSlideSession): Promise<Uint8Array> {
  const bytes = await savePptx(session.opened)
  commitSaved(session.opened)
  session.undoStack = []
  session.redoStack = []
  return bytes
}

// ── edit handlers (transcribed from slides-main.ts's slides:edit-* subset) ──

export function webEditText(
  session: WebSlideSession,
  op: EditTextOp,
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  if (op.groupId) {
    const found = findGroupChild(slide, op.groupId, op.sourceId)
    const child = found?.child
    if (!child || (child.type !== 'text' && child.type !== 'shape')) return null
    const textChild = child as TextElement
    if (!textChild.text) return null
    pushHistory(session)
    textChild.text.paragraphs = applyEditParagraphs(textChild.text.paragraphs, op.paragraphs)
    ensureRunLinkRels(session.opened, op.slideIndex, textChild.text.paragraphs)
    if (!patchGroupChildText(slide, op.groupId, textChild)) {
      session.undoStack.pop()
      return null
    }
    for (const { index, patch } of collectParagraphFormatPatches(op.paragraphs)) {
      setGroupChildParagraphFormat(slide, op.groupId, op.sourceId, patch, [index])
    }
    return rebuildSlide(session, op.slideIndex)
  }
  const el = findEl(slide, op.sourceId)
  if (!el || !el.text) return null
  pushHistory(session)
  el.text.paragraphs = applyEditParagraphs(el.text.paragraphs, op.paragraphs)
  ensureRunLinkRels(session.opened, op.slideIndex, el.text.paragraphs)
  el.dirty = true
  for (const { index, patch } of collectParagraphFormatPatches(op.paragraphs)) {
    setElementParagraphFormat(slide, op.sourceId, patch, [index])
  }
  if (levelsChanged(el.text.paragraphs, op.paragraphs)) {
    el.dirtyPPr = { ...el.dirtyPPr, level: true, indents: true }
    materializeSlide(session.opened, op.slideIndex)
    return rebuildSlide(session, op.slideIndex)
  }
  return rebuildSlide(session, op.slideIndex)
}

export function webSetElementFont(
  session: WebSlideSession,
  op: { slideIndex: number; sourceId: string; patch: Parameters<typeof setElementFont>[2] },
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  pushHistory(session)
  if (!setElementFont(slide, op.sourceId, op.patch)) {
    session.undoStack.pop()
    return null
  }
  return rebuildSlide(session, op.slideIndex)
}

export function webSetElementParagraphFormat(
  session: WebSlideSession,
  op: { slideIndex: number; sourceId: string; patch: ParagraphFormatPatch },
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  pushHistory(session)
  setElementParagraphFormat(slide, op.sourceId, op.patch)
  return rebuildSlide(session, op.slideIndex)
}

export function webEditTransform(
  session: WebSlideSession,
  op: EditTransformOp,
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  const el = op.groupId ? null : slide.elements.find((x) => x.id === op.sourceId)
  const grpChild = op.groupId ? findGroupChild(slide, op.groupId, op.sourceId) : null
  if (!el && !grpChild) return null
  if (!op.preview) pushHistory(session)
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = op.fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  if (grpChild) {
    const ok = editGroupChildTransform(
      slide,
      op.groupId!,
      op.sourceId,
      {
        x: toEmu(op.xPx),
        y: toEmu(op.yPx),
        cx: toEmu(op.wPx),
        cy: toEmu(op.hPx),
      },
      op.rotationDeg,
    )
    if (!ok) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }
  el!.transform = {
    ...el!.transform,
    offset: {
      x: toEmu(op.xPx),
      y: toEmu(op.yPx),
      cx: toEmu(op.wPx),
      cy: toEmu(op.hPx),
    },
    rot: Math.round(op.rotationDeg * 60000),
  }
  el!.dirtyTransform = true
  updateConnectorsForMoved(slide, [op.sourceId])
  return rebuildSlide(session, op.slideIndex)
}

export function webBatchEditTransform(
  session: WebSlideSession,
  op: BatchEditTransformOp,
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = op.fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  const pairs: Array<{ el: (typeof slide.elements)[0]; item: BatchEditTransformOp['items'][0] }> =
    []
  for (const item of op.items) {
    const el = slide.elements.find((x) => x.id === item.sourceId)
    if (!el) return null
    pairs.push({ el, item })
  }
  pushHistory(session)
  for (const { el, item } of pairs) {
    el.transform = {
      ...el.transform,
      offset: {
        x: toEmu(item.xPx),
        y: toEmu(item.yPx),
        cx: toEmu(item.wPx),
        cy: toEmu(item.hPx),
      },
      rot: Math.round(item.rotationDeg * 60000),
    }
    el.dirtyTransform = true
  }
  updateConnectorsForMoved(
    slide,
    op.items.map((i) => i.sourceId),
  )
  return rebuildSlide(session, op.slideIndex)
}

export function webEditFill(session: WebSlideSession, op: EditFillOp): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  if (op.groupId) {
    pushHistory(session)
    const fill =
      typeof op.fill === 'string'
        ? op.fill
        : {
            stops: [
              { pos: 0, color: op.fill.gradient.from },
              { pos: 1, color: op.fill.gradient.to },
            ],
            ...(op.fill.gradient.radial
              ? { path: 'circle' as const }
              : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) }),
          }
    if (!editGroupChildFill(slide, op.groupId, op.sourceId, fill)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }
  const el = findEl(slide, op.sourceId)
  if (!el) return null
  pushHistory(session)
  if (typeof op.fill === 'string') {
    el.fill = op.fill === 'none' ? { type: 'none' } : { type: 'solid', color: op.fill }
  } else {
    const g = op.fill.gradient
    el.fill = {
      type: 'gradient',
      stops: [
        { pos: 0, color: g.from },
        { pos: 1, color: g.to },
      ],
      ...(g.radial ? { path: 'circle' as const } : { angle: Math.round((g.angleDeg ?? 0) * 60000) }),
    }
  }
  el.dirtyFill = true
  return rebuildSlide(session, op.slideIndex)
}

export function webEditStroke(session: WebSlideSession, op: EditStrokeOp): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  if (op.groupId) {
    pushHistory(session)
    const stroke = op.stroke
      ? {
          color: op.stroke.color,
          widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
          ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
        }
      : null
    if (!editGroupChildStroke(slide, op.groupId, op.sourceId, stroke)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }
  // Unlike findEl, pictures are strokable too (picture border)
  const el = slide.elements.find(
    (x) =>
      x.id === op.sourceId && (x.type === 'text' || x.type === 'shape' || x.type === 'picture'),
  ) as TextElement | undefined
  if (!el) return null
  pushHistory(session)
  el.stroke = op.stroke
    ? {
        fill: { type: 'solid', color: op.stroke.color },
        width: Math.round(op.stroke.widthPt * EMU_PER_PT),
        ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
      }
    : undefined
  el.dirtyStroke = true
  return rebuildSlide(session, op.slideIndex)
}

export function webEditBackground(
  session: WebSlideSession,
  op: EditBackgroundOp,
): RenderSlide[] | null {
  const slides = session.opened.deck.slides
  const targets = op.slideIndex === -1 ? slides : [slides[op.slideIndex]].filter(Boolean)
  if (targets.length === 0) return null
  pushHistory(session)
  for (const s of targets) setSlideBackground(s!, op.color)
  session.fitWidthPx = op.fitWidthPx
  return buildAllRenderSlides(session.opened, op.fitWidthPx)
}

export function webAddElement(
  session: WebSlideSession,
  op: AddElementOp,
): { slide: RenderSlide; sourceId: string } | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  pushHistory(session)
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = op.fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  const paragraphs: Paragraph[] | undefined = op.paragraphs?.length
    ? (op.paragraphs as Paragraph[])
    : undefined
  const el = addElement(slide, {
    kind: op.kind,
    offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
    ...(paragraphs ? { paragraphs } : {}),
    ...(op.fillColor ? { fillColor: op.fillColor } : {}),
    ...(op.stroke
      ? {
          stroke: {
            color: op.stroke.color,
            widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
          },
        }
      : {}),
  })
  session.fitWidthPx = op.fitWidthPx
  const rebuilt = rebuildSlide(session, op.slideIndex)
  return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
}

export function webDeleteElement(
  session: WebSlideSession,
  op: { slideIndex: number; sourceId: string },
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  const index = slide.elements.findIndex((e) => e.id === op.sourceId)
  if (index < 0) return null
  pushHistory(session)
  slide.elements.splice(index, 1)
  return rebuildSlide(session, op.slideIndex)
}

export function webAddSlide(
  session: WebSlideSession,
  op: { sourceIndex: number; fitWidthPx: number; clearText?: boolean },
): { slides: RenderSlide[]; index: number } | null {
  pushHistory(session)
  const slide = duplicateSlide(session.opened, op.sourceIndex, { clearText: !!op.clearText })
  if (!slide) {
    session.undoStack.pop()
    return null
  }
  session.fitWidthPx = op.fitWidthPx
  return {
    slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
    index: op.sourceIndex + 1,
  }
}

export function webAddBlankSlide(
  session: WebSlideSession,
  op: { sourceIndex: number; fitWidthPx: number },
): { slides: RenderSlide[]; index: number } | null {
  pushHistory(session)
  const slide = insertBlankSlide(session.opened, op.sourceIndex)
  if (!slide) {
    session.undoStack.pop()
    return null
  }
  session.fitWidthPx = op.fitWidthPx
  return {
    slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
    index: op.sourceIndex + 1,
  }
}

export function webDeleteSlide(
  session: WebSlideSession,
  slideIndex: number,
): RenderSlide[] | null {
  pushHistory(session)
  if (!deleteSlideFromDeck(session.opened, slideIndex)) {
    session.undoStack.pop()
    return null
  }
  return buildAllRenderSlides(session.opened, session.fitWidthPx)
}

export function webReorderElement(
  session: WebSlideSession,
  op: { slideIndex: number; sourceId: string; dir: 'front' | 'back' | 'forward' | 'backward' },
): RenderSlide | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  pushHistory(session)
  if (!reorderElement(slide, op.sourceId, op.dir)) {
    session.undoStack.pop()
    return null
  }
  return rebuildSlide(session, op.slideIndex)
}

export function webSetNotes(
  session: WebSlideSession,
  slideIndex: number,
  text: string,
): boolean {
  if (!session.opened.deck.slides[slideIndex]) return false
  pushHistory(session)
  const ok = setSlideNotes(session.opened, slideIndex, text)
  if (!ok) session.undoStack.pop()
  return ok
}

export function webGetNotes(session: WebSlideSession, slideIndex: number): string {
  const slide = session.opened.deck.slides[slideIndex]
  return slide ? getSlideNotes(session.opened.archive, slide.path) : ''
}

// ── session holder (single document per tab — ASM-005) ─────────────────

let currentSession: WebSlideSession | null = null

export function getWebSession(): WebSlideSession | null {
  return currentSession
}

export function setWebSession(session: WebSlideSession | null): void {
  currentSession = session
}

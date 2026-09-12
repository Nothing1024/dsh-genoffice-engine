import { PDFDocument } from 'pdf-lib'

/** Extract the given pages (original indices) into bytes of a new PDF */
export async function extractPagesBytes(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const valid = pages.filter((p) => p >= 0 && p < src.getPageCount())
  const copied = await out.copyPages(src, valid)
  for (const p of copied) out.addPage(p)
  return out.save({ useObjectStreams: false })
}

/** Insert all pages of another PDF after afterPageIndex (-1 = front); returns merged bytes and inserted page count */
export async function insertPdfBytes(
  bytes: Uint8Array,
  otherBytes: Uint8Array,
  afterPageIndex: number,
): Promise<{ merged: Uint8Array; count: number }> {
  const dst = await PDFDocument.load(bytes, { updateMetadata: false })
  const src = await PDFDocument.load(otherBytes, { updateMetadata: false })
  const copied = await dst.copyPages(src, src.getPageIndices())
  let at = Math.min(Math.max(afterPageIndex + 1, 0), dst.getPageCount())
  for (const p of copied) dst.insertPage(at++, p)
  return { merged: await dst.save({ useObjectStreams: false }), count: copied.length }
}

/** Insert a blank page after afterPageIndex (-1 = front), sized like the neighboring page */
export async function insertBlankPageBytes(
  bytes: Uint8Array,
  afterPageIndex: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const at = Math.min(Math.max(afterPageIndex + 1, 0), doc.getPageCount())
  const ref = doc.getPage(Math.min(Math.max(afterPageIndex, 0), doc.getPageCount() - 1))
  const page = doc.insertPage(at, [ref.getWidth(), ref.getHeight()])
  page.setRotation(ref.getRotation())
  return doc.save({ useObjectStreams: false })
}

/** Grid shape for an N-up sheet: 2-up is a side-by-side pair, otherwise near-square */
export function mergeGrid(perSheet: number): { cols: number; rows: number } {
  const n = Math.min(Math.max(Math.floor(perSheet), 2), 16)
  if (n === 2) return { cols: 2, rows: 1 }
  const cols = Math.ceil(Math.sqrt(n))
  return { cols, rows: Math.ceil(n / cols) }
}

/**
 * Resize every page to the target paper size (points): content and annotations
 * scale uniformly to fit. Centering is done by shifting the MediaBox origin
 * instead of translating the content, so annotations stay aligned with the
 * content they belong to. Pages displayed sideways (/Rotate 90 or 270) get the
 * swapped target so their displayed size matches the chosen paper.
 */
export async function setPageSizeBytes(
  bytes: Uint8Array,
  targetW: number,
  targetH: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const page of doc.getPages()) {
    const rot = ((page.getRotation().angle % 360) + 360) % 360
    const tw = rot === 90 || rot === 270 ? targetH : targetW
    const th = rot === 90 || rot === 270 ? targetW : targetH
    const { x, y, width: w, height: h } = page.getMediaBox()
    if (w === tw && h === th) continue
    const k = Math.min(tw / w, th / h)
    page.scaleContent(k, k)
    page.scaleAnnotations(k, k)
    const bx = x * k - (tw - w * k) / 2
    const by = y * k - (th - h * k) / 2
    page.setMediaBox(bx, by, tw, th)
    page.setCropBox(bx, by, tw, th)
  }
  return doc.save({ useObjectStreams: false })
}

/** Map a fractional rect of the displayed page (after /Rotate, y down from the top) to user space */
function displayFracToUserRect(
  rot: number,
  box: { x: number; y: number; width: number; height: number },
  l: number,
  t: number,
  r: number,
  b: number,
): { x: number; y: number; w: number; h: number } {
  const { x: x0, y: y0, width: W, height: H } = box
  if (rot === 90) {
    return { x: x0 + t * W, y: y0 + l * H, w: (b - t) * W, h: (r - l) * H }
  }
  if (rot === 180) {
    return { x: x0 + (1 - r) * W, y: y0 + t * H, w: (r - l) * W, h: (b - t) * H }
  }
  if (rot === 270) {
    return { x: x0 + (1 - b) * W, y: y0 + (1 - r) * H, w: (b - t) * W, h: (r - l) * H }
  }
  return { x: x0 + l * W, y: y0 + (1 - b) * H, w: (r - l) * W, h: (b - t) * H }
}

/**
 * Split every page into a perPage grid of pages (left→right, top→bottom as
 * displayed), the inverse of mergePagesBytes: each cell becomes its own page via
 * a copy with a tightened MediaBox/CropBox, so content is preserved losslessly.
 */
export async function splitPagesBytes(bytes: Uint8Array, perPage: 2 | 4 | 9): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const { cols, rows } = mergeGrid(perPage)
  const total = src.getPageCount()
  for (let i = 0; i < total; i++) {
    const copies = await out.copyPages(
      src,
      Array.from({ length: perPage }, () => i),
    )
    for (let c = 0; c < perPage; c++) {
      const page = copies[c]!
      const rot = ((page.getRotation().angle % 360) + 360) % 360
      const col = c % cols
      const row = Math.floor(c / cols)
      const rect = displayFracToUserRect(
        rot,
        page.getCropBox(),
        col / cols,
        row / rows,
        (col + 1) / cols,
        (row + 1) / rows,
      )
      page.setMediaBox(rect.x, rect.y, rect.w, rect.h)
      page.setCropBox(rect.x, rect.y, rect.w, rect.h)
      out.addPage(page)
    }
  }
  return out.save({ useObjectStreams: false })
}

/** Crop rectangle as fractions of the displayed page (after /Rotate), y down from the top */
export interface CropFractionsRect {
  l: number
  t: number
  r: number
  b: number
}

/**
 * Shrink the CropBox of the given pages to the fractional rect. The fractions are
 * relative to the page as displayed (rotation applied, y down), so the same rect
 * lands on the same visual region regardless of each page's /Rotate value.
 */
export async function cropPagesBytes(
  bytes: Uint8Array,
  pages: number[],
  frac: CropFractionsRect,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const l = Math.min(Math.max(frac.l, 0), 1)
  const t = Math.min(Math.max(frac.t, 0), 1)
  const r = Math.min(Math.max(frac.r, l), 1)
  const b = Math.min(Math.max(frac.b, t), 1)
  if (r - l <= 0 || b - t <= 0) throw new Error('cropPages: empty crop rect')
  for (const idx of pages) {
    if (idx < 0 || idx >= doc.getPageCount()) continue
    const page = doc.getPage(idx)
    const rot = ((page.getRotation().angle % 360) + 360) % 360
    const rect = displayFracToUserRect(rot, page.getCropBox(), l, t, r, b)
    page.setCropBox(rect.x, rect.y, rect.w, rect.h)
  }
  return doc.save({ useObjectStreams: false })
}

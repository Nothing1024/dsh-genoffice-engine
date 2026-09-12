/**
 * Web xlsx media / pivot readers. Reuses gateway drawing-anchor indexes and
 * parsePivotDefinition (INV-003) instead of a second OOXML algorithm.
 */
import JSZip from 'jszip'
import type {
  WorkbookFile,
  WorkbookMediaResult,
  WorkbookPivotDefinition,
  WorkbookVisualObject,
} from '../shared/desktop-api'
import { workbookPivotDefinitionSchema } from '../shared/desktop-api'
import { relsPathFor, resolveRelTarget } from '../gateway/xlsx-drawing-add'
import { listDrawingAnchorXml } from '../gateway/xlsx-drawing-edit'
import { parsePivotDefinition } from '../gateway/xlsx-pivot'
import { parseRelationships } from '../gateway/xlsx-sheets'
import { columnIndex } from '../domain/cell-address'

const XML_NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
}

function decodeXmlText(input: string): string {
  return input.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));/g,
    (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) return XML_NAMED_ENTITIES[named] ?? _match
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec)
      return code <= 0x10ffff ? String.fromCodePoint(code) : _match
    },
  )
}

function readXmlAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attributes)
  return match?.[1] ?? null
}

function addressToRowCol(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address)
  if (!match) return { row: 0, column: 0 }
  return { row: Number(match[2]) - 1, column: columnIndex(match[1]!) }
}

function parseAnchorFromBlock(block: string): WorkbookVisualObject['anchor'] | null {
  const marker = (tag: string) => {
    const inner = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(
      block,
    )?.[1]
    if (!inner) return null
    return {
      row: Number(/<(?:\w+:)?row>(-?\d+)<\/(?:\w+:)?row>/.exec(inner)?.[1] ?? '0'),
      column: Number(/<(?:\w+:)?col>(-?\d+)<\/(?:\w+:)?col>/.exec(inner)?.[1] ?? '0'),
      rowOffset: Number(/<(?:\w+:)?rowOff>(-?\d+)<\/(?:\w+:)?rowOff>/.exec(inner)?.[1] ?? '0'),
      columnOffset: Number(/<(?:\w+:)?colOff>(-?\d+)<\/(?:\w+:)?colOff>/.exec(inner)?.[1] ?? '0'),
    }
  }
  const from = marker('from')
  if (!from) return null
  const to = marker('to') ?? from
  return {
    fromRow: from.row,
    fromColumn: from.column,
    fromRowOffset: from.rowOffset,
    fromColumnOffset: from.columnOffset,
    toRow: to.row,
    toColumn: to.column,
    toRowOffset: to.rowOffset,
    toColumnOffset: to.columnOffset,
    ...(/<(?:\w+:)?to\b/.test(block) ? { explicitTo: true } : {}),
  }
}

function mediaTypeForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  return undefined
}

export async function parseWorksheetVisuals(
  zip: JSZip,
  worksheetPath: string,
  sheetId: string,
  idOffset: number,
): Promise<WorkbookVisualObject[]> {
  const relsXml = await zip.file(relsPathFor(worksheetPath))?.async('text')
  if (!relsXml) return []
  const visuals: WorkbookVisualObject[] = []
  for (const rel of parseRelationships(relsXml)) {
    if (!rel.id || !rel.target || !rel.type.endsWith('/drawing')) continue
    const drawingPath = resolveRelTarget(worksheetPath, rel.target)
    const drawingXml = await zip.file(drawingPath)?.async('text')
    if (!drawingXml) continue
    const drawingRelsXml = (await zip.file(relsPathFor(drawingPath))?.async('text')) ?? ''
    const drawingRels = new Map(
      parseRelationships(drawingRelsXml)
        .filter((entry) => entry.id)
        .map((entry) => [entry.id as string, entry]),
    )
    const anchors = listDrawingAnchorXml(drawingXml)
    for (let index = 0; index < anchors.length; index++) {
      const block = anchors[index] ?? ''
      if (!/<(?:\w+:)?pic\b/.test(block)) continue
      const blip = /<(?:\w+:)?blip\b([^>]*)\/?>/.exec(block)
      if (!blip) continue
      const embed =
        readXmlAttribute(blip[1] ?? '', 'r:embed') ?? readXmlAttribute(blip[1] ?? '', 'embed')
      if (!embed) continue
      const imageRel = drawingRels.get(embed)
      if (!imageRel || !imageRel.type.endsWith('/image')) continue
      const mediaPath = resolveRelTarget(drawingPath, imageRel.target)
      const anchor = parseAnchorFromBlock(block)
      if (!anchor) continue
      if (
        anchor.fromRow === anchor.toRow &&
        anchor.fromColumn === anchor.toColumn &&
        anchor.fromRowOffset === anchor.toRowOffset &&
        anchor.fromColumnOffset === anchor.toColumnOffset
      ) {
        continue
      }
      const name = /<(?:\w+:)?cNvPr\b[^>]*\bname="([^"]+)"/.exec(block)?.[1]
      const mediaType = mediaTypeForPath(mediaPath)
      visuals.push({
        id: `visual-${idOffset + index + 1}`,
        sheetId,
        kind: 'image',
        anchor,
        mediaPath,
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(name ? { name: decodeXmlText(name) } : {}),
        drawingPath,
        drawingIndex: index,
      })
    }
  }
  return visuals
}

export async function parseWorksheetPivots(
  zip: JSZip,
  worksheetPath: string,
): Promise<{
  pivotTables: WorkbookFile['sheets'][number]['pivotTables']
  pivotRanges: WorkbookFile['sheets'][number]['pivotRanges']
}> {
  const relsXml = await zip.file(relsPathFor(worksheetPath))?.async('text')
  if (!relsXml) return { pivotTables: [], pivotRanges: [] }
  const pivotTables: WorkbookFile['sheets'][number]['pivotTables'] = []
  const pivotRanges: WorkbookFile['sheets'][number]['pivotRanges'] = []
  for (const rel of parseRelationships(relsXml)) {
    if (!rel.target || !rel.type.endsWith('/pivotTable')) continue
    const path = resolveRelTarget(worksheetPath, rel.target)
    const xml = await zip.file(path)?.async('text')
    if (!xml) continue
    const loc = /<(?:\w+:)?location\b([^>]*)\/?>/.exec(xml)
    const ref = loc ? readXmlAttribute(loc[1] ?? '', 'ref') : null
    if (!ref) continue
    const firstDataRow = Number(readXmlAttribute(loc[1] ?? '', 'firstDataRow') ?? '1')
    const firstDataCol = Number(readXmlAttribute(loc[1] ?? '', 'firstDataCol') ?? '1')
    const pivotRelsXml = (await zip.file(relsPathFor(path))?.async('text')) ?? ''
    const cacheRel = parseRelationships(pivotRelsXml).find((entry) =>
      entry.type.endsWith('/pivotCacheDefinition'),
    )
    const cachePath = cacheRel ? resolveRelTarget(path, cacheRel.target) : null
    const [from, to] = ref.split(':')
    const start = addressToRowCol(from ?? '')
    const end = addressToRowCol(to ?? from ?? '')
    if (start.row >= 0 && start.column >= 0 && end.row >= 0 && end.column >= 0) {
      pivotRanges.push({
        startRow: Math.min(start.row, end.row),
        endRow: Math.max(start.row, end.row),
        startColumn: Math.min(start.column, end.column),
        endColumn: Math.max(start.column, end.column),
      })
    }
    pivotTables.push({
      path,
      cachePath,
      outputRef: ref,
      firstDataRow,
      firstDataCol,
    })
  }
  return { pivotTables, pivotRanges }
}

export function sniffImageMediaType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/gif' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif'
  }
  return null
}

export function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (
    globalThis as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } }
  ).Buffer
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function readMediaPart(
  source: Uint8Array,
  mediaPath: string,
): Promise<WorkbookMediaResult> {
  const zip = await JSZip.loadAsync(source as unknown as ArrayBuffer)
  const entry = zip.file(mediaPath)
  if (!entry) throw new Error('Unknown workbook image.')
  const data = await entry.async('uint8array')
  if (data.byteLength > 20 * 1024 * 1024) {
    throw new Error('Embedded image exceeds the media response limit.')
  }
  const mediaType = sniffImageMediaType(data)
  if (mediaType === null) throw new Error('Embedded image is not PNG/JPEG/GIF.')
  return { mediaType, base64: bytesToBase64(data) }
}

export async function readPivotParts(
  source: Uint8Array,
  path: string,
  cachePath: string,
): Promise<WorkbookPivotDefinition> {
  const zip = await JSZip.loadAsync(source as unknown as ArrayBuffer)
  const pivotXml = await zip.file(path)?.async('text')
  const cacheXml = await zip.file(cachePath)?.async('text')
  if (!pivotXml || !cacheXml) throw new Error('Unknown pivot definition.')
  return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
}

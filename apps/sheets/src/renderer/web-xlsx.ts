/**
 * Browser-side xlsx reader/writer for the sheets web bridge.
 *
 * Read path: relay `/api/file` bytes → JSZip → `xl/workbook.xml` (sheet
 * order/names), `xl/_rels/workbook.xml.rels` (sheet part paths),
 * `xl/sharedStrings.xml`, per-worksheet XML (cells / merges / cols / freeze),
 * `xl/styles.xml` (numFmts + cellXfs → `WorkbookCellStyle[]`) → a
 * `WorkbookFile`-conformant snapshot the renderer's lazy model consumes
 * (`loadWorkbookSkeleton` + `readWorkbookRange`/`readWorkbookFormulas`).
 *
 * Save path: the renderer's edit journal arrives as `WorkbookSaveRequest`;
 * the gateway's pure-JSZip pipeline (`planCellEditsToXlsx` + `assembleWithJsZip`)
 * patches the ORIGINAL archive (only touched entries change — BR-009 fidelity),
 * the new bytes become the current file state (INV-005: no direct file writes,
 * all edits still go through Univer → journal).
 *
 * This module is only included by the web build (vite.web.config.ts); the
 * desktop build never sees it.
 */
// MUST precede every other import: installs globalThis.Buffer before JSZip
// evaluates its `support.nodebuffer` check (import order = evaluation order).
import './web-node-shims'
import JSZip from 'jszip'
import type {
  WorkbookFile,
  WorkbookRangeRequest,
  WorkbookRangeResult,
  WorkbookFormulaCellsResult,
  WorkbookSaveRequest,
  WorkbookCellStyle,
} from '../shared/desktop-api'
import {
  assembleWithJsZip,
  createBufferEntrySource,
  planCellEditsToXlsx,
} from '../gateway/xlsx-gateway'
import type { CellEdit, SheetStructuralOps } from '../gateway/xlsx-gateway'
import type { SheetEditPlan } from '../gateway/xlsx-sheets'
import { columnIndex } from '../domain/cell-address'

/** One record of workbookRangeResultSchema.cells (no exported type name). */
interface WebRangeCell {
  row: number
  column: number
  value: string | number | boolean | null
  formula?: string
  arrayRef?: string
  styleIndex?: number
}

/** One entry of gateway SheetFormulaValues.cells. */
interface SheetFormulaValueCell {
  row: number
  column: number
  value: string | number | boolean | null
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = map.get(key) ?? []
    bucket.push(item)
    map.set(key, bucket)
  }
  return map
}

// ── tiny XML helpers ────────────────────────────────────────────────────

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

function readChildText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
  return match?.[1] ?? null
}

// ── parsed model ────────────────────────────────────────────────────────

export interface WebSheetCell {
  value: string | number | boolean | null
  formula?: string
  styleIndex?: number
}

export interface WebSheetStore {
  id: string
  name: string
  rowCount: number
  columnCount: number
  cells: Map<string, WebSheetCell> // key: "row:col"
  merges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>
  columnWidths: Array<{
    startColumn: number
    endColumn: number
    width?: number
    hidden: boolean
  }>
  defaultRowHeight: number | null
  defaultColumnWidth: number | null
  freeze: { frozenColumns: number; frozenRows: number } | null
  hidden: boolean
  tabColor: string | null
  showGridLines: boolean
  showFormulas: boolean
  worksheetPath: string
}

export interface ParsedWorkbook {
  name: string
  sheets: WebSheetStore[]
  styles: WorkbookCellStyle[]
  entryCount: number
  sha256: string
}

const DEFAULT_ROW_COUNT = 1048576
const DEFAULT_COLUMN_COUNT = 16384
const MINIMUM_ROW_COUNT = 100
const MINIMUM_COLUMN_COUNT = 26

function addressToRowCol(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address)
  if (!match) return { row: 0, column: 0 }
  return { row: Number(match[2]) - 1, column: columnIndex(match[1]!) }
}

function styleFromXf(
  xf: string,
  numFmtById: Map<number, string>,
  fonts: string[],
  fills: string[],
  borders: string[],
): WorkbookCellStyle {
  const numFmtId = Number(readXmlAttribute(xf, 'numFmtId') ?? '0')
  const fontId = Number(readXmlAttribute(xf, 'fontId') ?? '0')
  const fillId = Number(readXmlAttribute(xf, 'fillId') ?? '0')
  const borderId = Number(readXmlAttribute(xf, 'borderId') ?? '0')
  const applyFont = readXmlAttribute(xf, 'applyFont') !== '0'
  const applyFill = readXmlAttribute(xf, 'applyFill') !== '0'
  const applyBorder = readXmlAttribute(xf, 'applyBorder') !== '0'
  const applyAlignment = readXmlAttribute(xf, 'applyAlignment') !== '0'
  const style: WorkbookCellStyle = {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    wrapText: false,
    diagonalUp: false,
    diagonalDown: false,
  }
  const font = fonts[fontId] ?? ''
  if (applyFont && font) {
    style.fontFamily = readXmlAttribute(font.match(/<name\b[^>]*>/)?.at(0) ?? '', 'val') ?? undefined
    const sz = Number(readXmlAttribute(font.match(/<sz\b[^>]*>/)?.at(0) ?? '', 'val') ?? '0')
    if (sz > 0) style.fontSize = sz
    style.bold = /<b\b/.test(font)
    style.italic = /<i\b/.test(font)
    style.underline = /<u\b/.test(font)
    style.strikethrough = /<strike\b/.test(font)
    const color = font.match(/<color\b[^>]*>/)
    if (color) {
      const rgb = readXmlAttribute(color[0], 'rgb')
      const theme = readXmlAttribute(color[0], 'theme')
      if (rgb) style.fontColor = `#${rgb.slice(-6).toLowerCase()}`
      else if (theme !== null) style.fontColor = undefined // theme colors unresolved — keep default
    }
  }
  const fill = fills[fillId] ?? ''
  if (applyFill && fill) {
    const fg = fill.match(/<fgColor\b[^>]*>/)
    if (fg) {
      const rgb = readXmlAttribute(fg[0], 'rgb')
      if (rgb) style.fillColor = `#${rgb.slice(-6).toLowerCase()}`
    }
  }
  const border = borders[borderId] ?? ''
  if (applyBorder && border) {
    for (const edge of ['top', 'bottom', 'left', 'right', 'diagonal'] as const) {
      const el = border.match(new RegExp(`<${edge}\\b[^>]*>`))
      if (!el) continue
      const s = readXmlAttribute(el[0], 'style')
      if (!s) continue
      const colorMatch = el[0].match(/<color\b[^>]*rgb="([0-9A-Fa-f]{8})"/)
      const color = colorMatch ? `#${colorMatch[1]!.slice(-6).toLowerCase()}` : undefined
      const key = `border${edge[0]!.toUpperCase()}${edge.slice(1)}` as
        | 'borderTop'
        | 'borderBottom'
        | 'borderLeft'
        | 'borderRight'
        | 'borderDiagonal'
      style[key] = color === undefined ? { style: s } : { style: s, color }
    }
    style.diagonalUp = /<diagonal\b[^>]*up="1"/.test(border)
    style.diagonalDown = /<diagonal\b/.test(border)
  }
  const alignment = xf.match(/<alignment\b[^>]*>/)
  if (applyAlignment && alignment) {
    const horizontal = readXmlAttribute(alignment[0], 'horizontal')
    if (horizontal) style.horizontalAlignment = horizontal
    const vertical = readXmlAttribute(alignment[0], 'vertical')
    if (vertical) style.verticalAlignment = vertical
    style.wrapText = readXmlAttribute(alignment[0], 'wrapText') === '1'
    const indent = Number(readXmlAttribute(alignment[0], 'indent') ?? '0')
    if (indent > 0) style.indent = indent
  }
  const format = numFmtById.get(numFmtId)
  if (format) style.numberFormat = format
  return style
}

async function parseStyles(zip: JSZip): Promise<{ styles: WorkbookCellStyle[] }> {
  const entry = zip.file('xl/styles.xml')
  if (!entry) return { styles: [] }
  const xml = await entry.async('text')
  const numFmtById = new Map<number, string>()
  const numFmts = readChildText(xml, 'numFmts') ?? ''
  for (const m of numFmts.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = Number(readXmlAttribute(m[0], 'numFmtId') ?? '-1')
    const code = readXmlAttribute(m[0], 'formatCode')
    if (id >= 0 && code) numFmtById.set(id, decodeXmlText(code))
  }
  // built-in number formats (ECMA-376 §18.8.30) — the subset most common in the wild
  const BUILTIN: Record<number, string> = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)',
    40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
    48: '##0.0E+0', 49: '@',
  }
  for (const [id, code] of Object.entries(BUILTIN)) numFmtById.set(Number(id), code)
  const fonts: string[] = []
  const fontsXml = readChildText(xml, 'fonts') ?? ''
  for (const m of fontsXml.matchAll(/<font(?:\s[^>]*)?>([\s\S]*?)<\/font>/g)) fonts.push(m[1] ?? '')
  const fills: string[] = []
  const fillsXml = readChildText(xml, 'fills') ?? ''
  for (const m of fillsXml.matchAll(/<fill(?:\s[^>]*)?>([\s\S]*?)<\/fill>/g)) fills.push(m[1] ?? '')
  const borders: string[] = []
  const bordersXml = readChildText(xml, 'borders') ?? ''
  for (const m of bordersXml.matchAll(/<border(?:\s[^>]*)?>([\s\S]*?)<\/border>/g)) borders.push(m[1] ?? '')
  const cellXfs = readChildText(xml, 'cellXfs') ?? ''
  const styles: WorkbookCellStyle[] = []
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    styles.push(styleFromXf(m[1] ?? '', numFmtById, fonts, fills, borders))
  }
  return { styles }
}

async function parseWorksheet(
  zip: JSZip,
  worksheetPath: string,
  id: string,
  name: string,
  sharedStrings: readonly string[],
): Promise<WebSheetStore> {
  const entry = zip.file(worksheetPath)
  if (!entry) throw new Error(`Workbook is missing ${worksheetPath}.`)
  const xml = await entry.async('text')
  const store: WebSheetStore = {
    id,
    name,
    rowCount: DEFAULT_ROW_COUNT,
    columnCount: DEFAULT_COLUMN_COUNT,
    cells: new Map(),
    merges: [],
    columnWidths: [],
    defaultRowHeight: null,
    defaultColumnWidth: null,
    freeze: null,
    hidden: false,
    tabColor: null,
    showGridLines: true,
    showFormulas: false,
    worksheetPath,
  }
  // <dimension ref="A1:C10"/> — the declared used range (absent in some files)
  const dimension = xml.match(/<dimension\b[^>]*\/>/)
  if (dimension) {
    const ref = readXmlAttribute(dimension[0], 'ref')
    if (ref) {
      const [from, to] = ref.split(':')
      const last = to ?? from
      if (last) {
        const { row, column } = addressToRowCol(last)
        if (row >= 0 && column >= 0) {
          store.rowCount = row + 1
          store.columnCount = column + 1
        }
      }
    }
  }
  // sheetFormatPr → defaults
  const sheetFormat = xml.match(/<sheetFormatPr\b[^>]*\/>/)
  if (sheetFormat) {
    const dh = Number(readXmlAttribute(sheetFormat[0], 'defaultRowHeight') ?? '0')
    if (dh > 0) store.defaultRowHeight = dh
    const dc = Number(readXmlAttribute(sheetFormat[0], 'defaultColWidth') ?? '0')
    if (dc > 0) store.defaultColumnWidth = dc
  }
  // cols → column widths (min/max are 1-based, inclusive)
  const colsXml = readChildText(xml, 'cols') ?? ''
  for (const m of colsXml.matchAll(/<col\b[^>]*\/>/g)) {
    const min = Number(readXmlAttribute(m[0], 'min') ?? '0')
    const max = Number(readXmlAttribute(m[0], 'max') ?? '0')
    const width = Number(readXmlAttribute(m[0], 'width') ?? '0')
    store.columnWidths.push({
      startColumn: Math.max(0, min - 1),
      endColumn: Math.max(min - 1, max - 1),
      ...(width > 0 ? { width } : {}),
      hidden: readXmlAttribute(m[0], 'hidden') === '1',
    })
  }
  // sheetViews → freeze panes / showGridLines / showFormulas
  const sheetViews = xml.match(/<sheetViews>[\s\S]*?<\/sheetViews>/)?.[0] ?? ''
  const pane = sheetViews.match(/<pane\b[^>]*\/>/)?.[0]
  if (pane) {
    const xSplit = Number(readXmlAttribute(pane, 'xSplit') ?? '0')
    const ySplit = Number(readXmlAttribute(pane, 'ySplit') ?? '0')
    if (xSplit > 0 || ySplit > 0) {
      store.freeze = { frozenColumns: xSplit, frozenRows: ySplit }
    }
  }
  const sheetView = sheetViews.match(/<sheetView\b[^>]*>/)?.[0]
  if (sheetView) {
    store.showGridLines = readXmlAttribute(sheetView, 'showGridLines') !== '0'
    store.showFormulas = readXmlAttribute(sheetView, 'showFormulas') === '1'
  }
  // sheetPr → tabColor
  const sheetPr = xml.match(/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>|<\/sheetPr>/)?.[0] ?? ''
  const tabColor = sheetPr.match(/<tabColor\b[^>]*rgb="([0-9A-Fa-f]{8})"/)
  if (tabColor) store.tabColor = `#${tabColor[1]!.slice(-6).toLowerCase()}`
  // mergeCells
  const mergeXml = readChildText(xml, 'mergeCells') ?? ''
  for (const m of mergeXml.matchAll(/<mergeCell\b[^>]*\/>/g)) {
    const ref = readXmlAttribute(m[0], 'ref')
    if (!ref) continue
    const [from, to] = ref.split(':')
    if (!from || !to) continue
    const a = addressToRowCol(from)
    const b = addressToRowCol(to)
    store.merges.push({
      startRow: Math.min(a.row, b.row),
      endRow: Math.max(a.row, b.row),
      startColumn: Math.min(a.column, b.column),
      endColumn: Math.max(a.column, b.column),
    })
  }
  // cells
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let match: RegExpExecArray | null
  while ((match = cellPattern.exec(xml)) !== null) {
    const attributes = match[1] ?? ''
    const address = readXmlAttribute(attributes, 'r')
    if (!address) continue
    const { row, column } = addressToRowCol(address)
    if (row < 0 || column < 0) continue
    const body = match[2] ?? ''
    const styleIndexRaw = readXmlAttribute(attributes, 's')
    const styleIndex = styleIndexRaw === null ? undefined : Number(styleIndexRaw)
    const formulaMatch = /<f(?:\s[^>]*[^/>])?>([\s\S]*?)<\/f>/.exec(body)
    const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
    let value: string | number | boolean | null = null
    const type = readXmlAttribute(attributes, 't')
    if (type === 'inlineStr') {
      value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((textMatch) => decodeXmlText(textMatch[1] ?? ''))
        .join('')
    } else if (valueMatch) {
      const rawValue = valueMatch[1] ?? ''
      if (type === 's') {
        value = sharedStrings[Number(rawValue)] ?? ''
      } else if (type === 'b') {
        value = rawValue === '1'
      } else if (type === 'str') {
        value = decodeXmlText(rawValue)
      } else {
        const numericValue = Number(rawValue)
        value = Number.isFinite(numericValue) ? numericValue : decodeXmlText(rawValue)
      }
    } else if (type === 'inlineStr' || type === 's') {
      value = ''
    }
    const cell: WebSheetCell = { value }
    if (formulaMatch) {
      cell.formula = `=${decodeXmlText(formulaMatch[1] ?? '')}`
    }
    if (styleIndex !== undefined) cell.styleIndex = styleIndex
    store.cells.set(`${row}:${column}`, cell)
    if (row + 1 > store.rowCount) store.rowCount = row + 1
    if (column + 1 > store.columnCount) store.columnCount = column + 1
  }
  store.rowCount = Math.max(MINIMUM_ROW_COUNT, store.rowCount)
  store.columnCount = Math.max(MINIMUM_COLUMN_COUNT, store.columnCount)
  return store
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function readSharedStrings(zip: JSZip): Promise<readonly string[]> {
  const entry = zip.file('xl/sharedStrings.xml')
  if (!entry) return []
  const xml = await entry.async('text')
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((itemMatch) =>
    [...(itemMatch[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => decodeXmlText(textMatch[1] ?? ''))
      .join(''),
  )
}

/**
 * Parse xlsx bytes into the renderer's lazy-file model. `name` is the file
 * name (used for the WorkbookFile identity).
 */
export async function parseXlsxWorkbook(
  bytes: Uint8Array,
  name: string,
): Promise<{ file: WorkbookFile; store: ParsedWorkbook }> {
  const zip = await JSZip.loadAsync(bytes as unknown as ArrayBuffer, { checkCRC32: true })
  const workbookXml = await zip.file('xl/workbook.xml')?.async('text')
  if (!workbookXml) throw new Error('Workbook is missing xl/workbook.xml.')
  const sharedStrings = await readSharedStrings(zip)
  const { styles } = await parseStyles(zip)
  // workbook rels: rId → worksheet part target
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text')
  const rels = new Map<string, string>()
  for (const m of (relsXml ?? '').matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = readXmlAttribute(m[0], 'Id')
    const target = readXmlAttribute(m[0], 'Target')
    if (id && target) {
      rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    }
  }
  const sheetPattern = /<sheet\b([^>]*?)\/?>/g
  const sheets: WebSheetStore[] = []
  let match: RegExpExecArray | null
  while ((match = sheetPattern.exec(workbookXml)) !== null) {
    const attributes = match[1] ?? ''
    const sheetName = readXmlAttribute(attributes, 'name')
    const sheetNumber = readXmlAttribute(attributes, 'sheetId')
    const rid = readXmlAttribute(attributes, 'r:id')
    if (!sheetName || !sheetNumber || !rid) continue
    const path = rels.get(rid)
    if (!path) continue
    const id = `sheet-${sheetNumber}`
    sheets.push(
      await parseWorksheet(
        zip,
        path,
        id,
        decodeXmlText(sheetName),
        sharedStrings,
      ),
    )
  }
  if (sheets.length === 0) throw new Error('Workbook contains no readable worksheets.')
  const sha256 = await sha256Hex(bytes)
  const file: WorkbookFile = {
    sessionId: crypto.randomUUID(),
    name,
    path: undefined,
    sha256,
    activeTab: 0,
    entryCount: Object.keys(zip.files).filter((p) => !zip.files[p]?.dir).length,
    sheets: sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      columnWidths: sheet.columnWidths.map((col) => ({
        startColumn: col.startColumn,
        endColumn: col.endColumn,
        ...(col.width === undefined ? {} : { width: col.width }),
        hidden: col.hidden,
      })),
      defaultRowHeight: sheet.defaultRowHeight,
      defaultColumnWidth: sheet.defaultColumnWidth,
      freeze: sheet.freeze,
      hidden: sheet.hidden,
      tabColor: sheet.tabColor,
      showGridLines: sheet.showGridLines,
      ...(sheet.showFormulas ? { showFormulas: true } : {}),
      tables: [],
      comments: [],
      pivotRanges: [],
      pivotTables: [],
      sparklines: [],
      ...(sheet.defaultRowHeight === null ? {} : {}),
    })),
    styles,
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
  }
  return { file, store: { name, sheets, styles, entryCount: file.entryCount, sha256 } }
}

// ── range / formula readers (renderer lazy model) ───────────────────────

export function buildRangeResult(
  store: ParsedWorkbook,
  request: WorkbookRangeRequest,
): WorkbookRangeResult {
  const sheet = store.sheets.find((candidate) => candidate.id === request.sheetId)
  const cells: WebRangeCell[] = []
  const merges: WorkbookRangeResult['merges'] = []
  if (sheet) {
    const { startRow, endRow, startColumn, endColumn } = request.range
    const MAX = 100_000
    let count = 0
    for (const [key, cell] of sheet.cells) {
      if (count >= MAX) break
      const [rowText, columnText] = key.split(':')
      const row = Number(rowText)
      const column = Number(columnText)
      if (row < startRow || row > endRow || column < startColumn || column > endColumn) continue
      const record: WebRangeCell = { row, column, value: cell.value }
      if (cell.formula !== undefined) record.formula = cell.formula
      if (cell.styleIndex !== undefined) record.styleIndex = cell.styleIndex
      cells.push(record)
      count++
    }
    for (const merge of sheet.merges) {
      if (
        merge.endRow < startRow || merge.startRow > endRow ||
        merge.endColumn < startColumn || merge.startColumn > endColumn
      ) continue
      merges.push(merge)
    }
  }
  return {
    cells,
    rows: [],
    merges,
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    dataValidations: [],
    sheetProtection: null,
    rowBreaks: [],
    colBreaks: [],
    protectedRanges: [],
    // the in-memory model is fully indexed: report the sheet's full extent so
    // the renderer's streaming poll stops and requested ranges patch
    // immediately (desktop sidecar streams incrementally; we already have all
    // rows parsed)
    indexedThroughRow: sheet ? Math.max(0, sheet.rowCount - 1) : null,
    indexingComplete: true,
  }
}

export function buildFormulaResult(
  store: ParsedWorkbook,
  sheetId: string,
): WorkbookFormulaCellsResult {
  const sheet = store.sheets.find((candidate) => candidate.id === sheetId)
  const cells: WorkbookFormulaCellsResult['cells'] = []
  if (sheet) {
    for (const [key, cell] of sheet.cells) {
      if (cell.formula === undefined) continue
      const [rowText, columnText] = key.split(':')
      cells.push({
        row: Number(rowText),
        column: Number(columnText),
        value: cell.value,
        formula: cell.formula,
        ...(cell.styleIndex === undefined ? {} : { styleIndex: cell.styleIndex }),
      })
    }
  }
  return { cells, indexingComplete: true, truncated: false }
}

// ── save path (gateway pure-JSZip pipeline) ─────────────────────────────

/**
 * Apply a renderer save request to the current file bytes via the gateway.
 * Returns the new bytes plus the rebuilt WorkbookFile (same shape the desktop
 * main process returns from saveWorkbookEdits).
 */
export async function applySaveRequest(
  source: Uint8Array,
  name: string,
  request: WorkbookSaveRequest,
): Promise<{ bytes: Uint8Array; file: WorkbookFile; touchedEntries: readonly string[] }> {
  const zip = await JSZip.loadAsync(source as unknown as ArrayBuffer)
  const workbookXml = await zip.file('xl/workbook.xml')?.async('text')
  if (!workbookXml) throw new Error('Workbook is missing xl/workbook.xml.')
  // sheetId ("sheet-N") ↔ worksheet part target, same resolution as parse
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text')
  const rels = new Map<string, string>()
  for (const m of (relsXml ?? '').matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = readXmlAttribute(m[0], 'Id')
    const target = readXmlAttribute(m[0], 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  const sheetNamesById = new Map<string, string>()
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const nameAttr = readXmlAttribute(m[1] ?? '', 'name')
    const sheetNumber = readXmlAttribute(m[1] ?? '', 'sheetId')
    const rid = readXmlAttribute(m[1] ?? '', 'r:id')
    if (nameAttr && sheetNumber && rid && rels.has(rid)) {
      sheetNamesById.set(`sheet-${sheetNumber}`, decodeXmlText(nameAttr))
    }
  }
  // Sheet ops resolve first: added sheets have Univer ids the file map
  // doesn't know, so cell edits into them resolve through the op's name.
  const addedSheetNames = new Map<string, string>()
  const duplicateSources = new Map<string, string>()
  const renames: { sheetName: string; newName: string }[] = []
  const removals: string[] = []
  const hiddenChanges: { sheetName: string; hidden: boolean }[] = []
  let orderChanged = false
  for (const op of request.sheetOps) {
    if (op.kind === 'add-sheet') {
      addedSheetNames.set(op.sheetId, op.name)
      continue
    }
    if (op.kind === 'duplicate-sheet') {
      const sourceName = addedSheetNames.get(op.sourceSheetId) ?? sheetNamesById.get(op.sourceSheetId)
      if (!sourceName) throw new Error(`Unknown duplicate source ${op.sourceSheetId}.`)
      addedSheetNames.set(op.sheetId, op.name)
      duplicateSources.set(op.sheetId, sourceName)
      continue
    }
    if (op.kind === 'reorder-sheets') {
      orderChanged = true
      continue
    }
    const sheetName = addedSheetNames.get(op.sheetId) ?? sheetNamesById.get(op.sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${op.sheetId}.`)
    if (op.kind === 'rename-sheet') renames.push({ sheetName, newName: op.newName })
    else if (op.kind === 'set-sheet-hidden') hiddenChanges.push({ sheetName, hidden: op.hidden })
    else removals.push(sheetName)
  }
  const renameByOriginal = new Map(renames.map((rename) => [rename.sheetName, rename.newName]))
  const resolveSheetName = (sheetId: string): string => {
    const sheetName = addedSheetNames.get(sheetId) ?? sheetNamesById.get(sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet for save: ${sheetId}`)
    return sheetName
  }
  let sheetPlan: SheetEditPlan | undefined
  if (request.sheetOps.length > 0) {
    sheetPlan = {
      renames,
      additions: [...addedSheetNames].map(([sheetId, name]) => ({
        name,
        sourceSheetName: duplicateSources.get(sheetId),
      })),
      removals,
      hiddenChanges,
      orderChanged,
      order: request.sheetOrder.map((sheetId) => {
        const original = resolveSheetName(sheetId)
        return addedSheetNames.has(sheetId)
          ? original
          : (renameByOriginal.get(original) ?? original)
      }),
    }
  }
  const edits: CellEdit[] = request.edits.map((edit) => ({
    sheetName: resolveSheetName(edit.sheetId),
    row: edit.row,
    column: edit.column,
    writeValue: edit.writeValue,
    cell: { value: edit.value, formula: edit.formula },
    style: edit.style,
    ...(edit.rich === undefined ? {} : { rich: edit.rich }),
    ...(edit.styleReset === undefined ? {} : { styleReset: edit.styleReset }),
  }))
  // structural ops grouped by sheet — same discrimination as the desktop main
  // process (sheets-main.ts toGatewayStructuralOps)
  const opsBySheet = new Map<string, SheetStructuralOps['ops'][number][]>()
  for (const op of request.structuralOps) {
    const sheetName = resolveSheetName(op.sheetId)
    const sheetOps = opsBySheet.get(sheetName) ?? []
    if ('range' in op) {
      sheetOps.push({ kind: op.kind, range: op.range })
    } else if ('size' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, size: op.size })
    } else if ('level' in op) {
      sheetOps.push({
        kind: op.kind,
        start: op.start,
        end: op.end,
        level: op.level,
        ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }),
      })
    } else if ('hidden' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, hidden: op.hidden })
    } else if ('before' in op) {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count, before: op.before })
    } else {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count })
    }
    opsBySheet.set(sheetName, sheetOps)
  }
  const structuralOps: SheetStructuralOps[] = [...opsBySheet].map(([sheetName, ops]) => ({
    sheetName,
    ops,
  }))
  const sheetProtections = request.sheetProtections.map((p) => ({
    sheetName: resolveSheetName(p.sheetId),
    protected: p.protected,
  }))
  const noteStates = request.noteStates.map((n) => ({
    sheetName: resolveSheetName(n.sheetId),
    notes: n.notes,
  }))
  const filterStates = request.filterStates.map((f) => ({
    sheetName: resolveSheetName(f.sheetId),
    filter: f.filter,
    hiddenRows: f.hiddenRows,
    visibilityRange: f.visibilityRange,
  }))
  const hyperlinkEdits = [...groupBy(request.hyperlinkEdits, (h) => h.sheetId)].map(
    ([sheetId, edits]) => ({
      sheetName: resolveSheetName(sheetId),
      edits: edits.map((e) => ({ row: e.row, column: e.column, target: e.target })),
    }),
  )
  // formulaValues arrive flat ({sheetId,row,column,value}); the gateway wants
  // them grouped per sheet with the sheet name resolved
  const formulaValuesBySheet = new Map<string, SheetFormulaValueCell[]>()
  for (const f of request.formulaValues) {
    const sheetName = resolveSheetName(f.sheetId)
    const cells = formulaValuesBySheet.get(sheetName) ?? []
    cells.push({ row: f.row, column: f.column, value: f.value })
    formulaValuesBySheet.set(sheetName, cells)
  }
  const formulaValues = [...formulaValuesBySheet].map(([sheetName, cells]) => ({
    sheetName,
    cells,
  }))
  const cfStates = [...groupBy(request.cfStates, (s) => s.sheetId)].map(([sheetId, states]) => ({
    sheetName: resolveSheetName(sheetId),
    rules: states.flatMap((s) => s.rules),
  }))
  const dvStates = [...groupBy(request.dvStates, (s) => s.sheetId)].map(([sheetId, states]) => ({
    sheetName: resolveSheetName(sheetId),
    rules: states.flatMap((s) => s.rules),
  }))
  const pageSetupStates = request.pageSetupStates.map((p) => ({
    sheetName: resolveSheetName(p.sheetId),
    ...(p.orientation === undefined ? {} : { orientation: p.orientation }),
    ...(p.paperSize === undefined ? {} : { paperSize: p.paperSize }),
    ...(p.scale === undefined ? {} : { scale: p.scale }),
    ...(p.fitToWidth === undefined ? {} : { fitToWidth: p.fitToWidth }),
    ...(p.fitToHeight === undefined ? {} : { fitToHeight: p.fitToHeight }),
    ...(p.fitToPage === undefined ? {} : { fitToPage: p.fitToPage }),
    ...(p.margins === undefined ? {} : { margins: p.margins }),
    ...(p.printGridlines === undefined ? {} : { printGridlines: p.printGridlines }),
    ...(p.printHeadings === undefined ? {} : { printHeadings: p.printHeadings }),
    ...(p.showGridlines === undefined ? {} : { showGridlines: p.showGridlines }),
    ...(p.showFormulas === undefined ? {} : { showFormulas: p.showFormulas }),
    ...(p.printArea === undefined ? {} : { printArea: p.printArea }),
    ...(p.printTitles === undefined ? {} : { printTitles: p.printTitles }),
    ...(p.frozenRows === undefined ? {} : { frozenRows: p.frozenRows }),
    ...(p.frozenColumns === undefined ? {} : { frozenColumns: p.frozenColumns }),
    ...(p.header === undefined ? {} : { header: p.header }),
    ...(p.footer === undefined ? {} : { footer: p.footer }),
  }))
  const bulkConstantFills = (request.bulkConstantFills ?? []).map(({ sheetId, ...fill }) => ({
    sheetName: resolveSheetName(sheetId),
    ...fill,
  }))
  const protectedRangeStates = request.protectedRangeStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    ranges: state.ranges,
  }))
  const visualAdditions = request.visualAdditions.map((addition) => ({
    sheetName: resolveSheetName(addition.sheetId),
    anchor: addition.anchor,
    chart: addition.chart,
    shape: addition.shape,
    image: addition.image,
  }))
  const tableAdditions = request.tableAdditions.map((table) => ({
    sheetName: resolveSheetName(table.sheetId),
    area: table.area,
    name: table.name,
    columnNames: table.columnNames,
    style: table.style,
    bandedRows: table.bandedRows,
  }))
  const pivotAdditions = request.pivotAdditions.map((pivot) => ({
    sheetName: resolveSheetName(pivot.sheetId),
    sourceSheetName: resolveSheetName(pivot.sourceSheetId),
    sourceArea: pivot.sourceArea,
    location: pivot.location,
    name: pivot.name,
    fieldNames: pivot.fieldNames,
    rowFieldIndices: pivot.rowFieldIndices,
    columnFieldIndex: pivot.columnFieldIndex,
    pageFieldIndices: pivot.pageFieldIndices,
    rowItems: pivot.rowItems,
    rowLevelItems: pivot.rowLevelItems,
    rowLines: pivot.rowLines,
    columnItems: pivot.columnItems,
    columnFieldIndices: pivot.columnFieldIndices,
    colLevelItems: pivot.colLevelItems,
    colLines: pivot.colLines,
    groupings: pivot.groupings,
    filters: pivot.filters,
    rowHiddenItems: pivot.rowHiddenItems,
    colHiddenItems: pivot.colHiddenItems,
    values: pivot.values,
  }))
  const sparklineAdditions = request.sparklineAdditions.map(({ sheetId, ...group }) => ({
    sheetName: resolveSheetName(sheetId),
    ...group,
  }))
  const pivotRefreshUpdates = request.pivotRefreshUpdates.map((update) => ({
    cachePath: update.cachePath,
    sheetName: resolveSheetName(update.sheetId),
    newOutputRef: update.newOutputRef,
    ...(update.relayout === undefined
      ? {}
      : {
          relayout: (({ sheetId: _sheetId, sourceSheetId, ...rest }) => ({
            ...rest,
            sourceSheetName: resolveSheetName(sourceSheetId),
          }))(update.relayout),
        }),
  }))
  // Same argument order as saveWorkbookViaSidecar / planCellEditsToXlsx.
  // Do not call applyCellEditsToXlsx: that helper hard-zeros visual/table/pivot
  // /sparkline/theme/protection/bulk fills.
  const sourceBuffer = source as never
  const plan = await planCellEditsToXlsx(
    await createBufferEntrySource(sourceBuffer),
    edits,
    structuralOps,
    request.chartEdits,
    sheetPlan,
    filterStates,
    hyperlinkEdits,
    cfStates,
    dvStates,
    sheetProtections,
    request.definedNamesState,
    visualAdditions,
    pageSetupStates,
    noteStates,
    tableAdditions,
    pivotAdditions,
    request.pivotCacheRefreshPaths,
    pivotRefreshUpdates,
    request.visualEdits,
    sparklineAdditions,
    formulaValues,
    request.themeState,
    request.workbookProtectionState,
    protectedRangeStates,
    bulkConstantFills,
  )
  const mutation = await assembleWithJsZip(sourceBuffer, plan)
  const bytes = mutation.buffer
  const rebuilt = await parseXlsxWorkbook(bytes, name)
  return { bytes, file: rebuilt.file, touchedEntries: mutation.touchedEntries }
}
/**
 * PDF → Office conversion worker (web). Owns PDFium wasm + @genoffice/pdf2docx.
 * Cancel is cooperative: a `cancel` message flips aborted; onProgress throws
 * so extract stops before any output bytes are produced.
 */
import {
  convertPdfToDocx,
  convertPdfToPptx,
  convertPdfToXlsx,
} from '@genoffice/pdf2docx'
import type { PdfiumModule } from '@genoffice/pdf2docx'
import { init } from '@embedpdf/pdfium'
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

export type ConvertFormat = 'docx' | 'pptx' | 'xlsx'

type InMsg =
  | { type: 'convert'; format: ConvertFormat; pdf: ArrayBuffer }
  | { type: 'cancel' }

type OutMsg =
  | { type: 'progress'; page: number; total: number }
  | { type: 'done'; bytes: ArrayBuffer; scannedDocument: boolean; warnings: string[] }
  | { type: 'canceled' }
  | { type: 'error'; error: string }

let aborted = false
let pdfiumPromise: Promise<PdfiumModule> | null = null

async function loadPdfium(): Promise<PdfiumModule> {
  pdfiumPromise ??= (async () => {
    const resp = await fetch(pdfiumWasmUrl)
    if (!resp.ok) throw new Error(`wasm load failed: ${resp.status}`)
    const raw = new Uint8Array(await resp.arrayBuffer())
    const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    const wrapped = (await init({ wasmBinary })) as unknown as { pdfium?: PdfiumModule } | PdfiumModule
    const m = ('pdfium' in wrapped && wrapped.pdfium ? wrapped.pdfium : wrapped) as PdfiumModule & {
      _PDFiumExt_Init(): void
    }
    m._PDFiumExt_Init()
    return m
  })()
  return pdfiumPromise
}

function post(msg: OutMsg, transfer?: Transferable[]): void {
  const scope = self as unknown as {
    postMessage(message: unknown, transfer?: Transferable[]): void
  }
  if (transfer) scope.postMessage(msg, transfer)
  else scope.postMessage(msg)
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  if (msg.type === 'cancel') {
    aborted = true
    return
  }
  if (msg.type !== 'convert') return
  void (async () => {
    aborted = false
    try {
      const pdfium = await loadPdfium()
      if (aborted) {
        post({ type: 'canceled' })
        return
      }
      const onProgress = (page: number, total: number) => {
        if (aborted) {
          const err = new Error('canceled')
          ;(err as Error & { canceled?: boolean }).canceled = true
          throw err
        }
        post({ type: 'progress', page, total })
      }
      const pdf = new Uint8Array(msg.pdf)
      const opts = { pdfium, onProgress }
      let bytes: Uint8Array
      let scannedDocument = false
      let warnings: string[] = []
      if (msg.format === 'docx') {
        const r = await convertPdfToDocx(pdf, opts)
        bytes = r.docx
        scannedDocument = r.scannedDocument
        warnings = r.warnings
      } else if (msg.format === 'pptx') {
        const r = await convertPdfToPptx(pdf, opts)
        bytes = r.pptx
        scannedDocument = r.scannedDocument
        warnings = r.warnings
      } else if (msg.format === 'xlsx') {
        const r = await convertPdfToXlsx(pdf, opts)
        bytes = r.xlsx
        scannedDocument = r.scannedDocument
        warnings = r.warnings
      } else {
        throw new Error(`unsupported convert format: ${String(msg.format)}`)
      }
      if (aborted) {
        post({ type: 'canceled' })
        return
      }
      const copy = bytes.slice()
      post(
        { type: 'done', bytes: copy.buffer, scannedDocument, warnings },
        [copy.buffer],
      )
    } catch (e) {
      const canceled =
        aborted ||
        (e instanceof Error && ((e as Error & { canceled?: boolean }).canceled || e.message === 'canceled'))
      if (canceled) post({ type: 'canceled' })
      else post({ type: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  })()
}

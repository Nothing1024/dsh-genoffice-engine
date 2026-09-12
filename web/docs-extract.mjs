/**
 * Isolated attachment-text extract. PDF reuses pdfjs-dist the same way
 * packages/file-parse/src/pdf.ts does. Extracted text is returned to the
 * caller and never logged.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function standardFontDataUrl() {
  try {
    const pdfPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
    return `${join(dirname(pdfPath), '..', '..', 'standard_fonts')}/`
  } catch {
    return undefined
  }
}

function installDomMatrixPolyfill() {
  const g = globalThis
  if (g.DOMMatrix) return
  class DOMMatrixPolyfill {
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0
    constructor(init) {
      if (Array.isArray(init) && init.length >= 6) {
        ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
      } else if (init && typeof init === 'object') {
        this.a = init.a
        this.b = init.b
        this.c = init.c
        this.d = init.d
        this.e = init.e
        this.f = init.f
      }
    }
    get is2D() {
      return true
    }
    get isIdentity() {
      return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
    }
    multiply(other) {
      const o = other ?? new DOMMatrixPolyfill()
      const next = new DOMMatrixPolyfill()
      next.a = this.a * o.a + this.c * o.b
      next.b = this.b * o.a + this.d * o.b
      next.c = this.a * o.c + this.c * o.d
      next.d = this.b * o.c + this.d * o.d
      next.e = this.a * o.e + this.c * o.f + this.e
      next.f = this.b * o.e + this.d * o.f + this.f
      return next
    }
    translate(x = 0, y = 0) {
      return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, x, y]))
    }
    scale(x = 1, y = x) {
      return this.multiply(new DOMMatrixPolyfill([x, 0, 0, y, 0, 0]))
    }
    inverse() {
      const det = this.a * this.d - this.b * this.c
      const next = new DOMMatrixPolyfill()
      if (!det) return next
      next.a = this.d / det
      next.b = -this.b / det
      next.c = -this.c / det
      next.d = this.a / det
      next.e = (this.c * this.f - this.d * this.e) / det
      next.f = (this.b * this.e - this.a * this.f) / det
      return next
    }
    transformPoint(p = {}) {
      const x = p.x ?? 0
      const y = p.y ?? 0
      return {
        x: this.a * x + this.c * y + this.e,
        y: this.b * x + this.d * y + this.f,
        z: 0,
        w: 1,
      }
    }
  }
  g.DOMMatrix = DOMMatrixPolyfill
}

export function extractReady() {
  if (process.env.GENOFFICE_DOCS_EXTRACT_DISABLED === '1') {
    return { available: false, reason: 'docs-extract-disabled' }
  }
  try {
    require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
    return { available: true, executor: 'pdfjs-dist' }
  } catch {
    return { available: false, reason: 'pdfjs-missing' }
  }
}

async function pdfToText(bytes) {
  installDomMatrixPolyfill()
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const fontUrl = standardFontDataUrl()
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    ...(fontUrl ? { standardFontDataUrl: fontUrl } : {}),
    verbosity: 0,
  })
  const doc = await loadingTask.promise
  try {
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str
          if (item.hasEOL) text += '\n'
        }
      }
      pages.push(text.trim())
      page.cleanup()
    }
    return pages.join('\n\n')
  } finally {
    await loadingTask.destroy()
  }
}

export async function extractAttachmentRequest(body) {
  const ready = extractReady()
  if (!ready.available) {
    return { ok: false, available: false, error: ready.reason }
  }
  if (process.env.GENOFFICE_DOCS_EXTRACT_FAIL === '1') {
    return { ok: false, available: true, error: 'docs-extract-fail' }
  }
  const name = typeof body?.name === 'string' ? body.name : 'attachment.bin'
  const ext = String(name.split('.').pop() ?? '').toLowerCase()
  if (ext !== 'pdf') return { ok: false, error: `unsupported-extract-ext:${ext}` }
  if (typeof body?.bytesBase64 !== 'string' || !body.bytesBase64) {
    return { ok: false, error: 'missing-bytes' }
  }
  let bytes
  try {
    bytes = Buffer.from(body.bytesBase64, 'base64')
  } catch {
    return { ok: false, error: 'invalid-base64' }
  }
  if (bytes.length < 5 || bytes.subarray(0, 4).toString() !== '%PDF') {
    return { ok: false, error: 'not-a-pdf' }
  }
  try {
    const text = await pdfToText(bytes)
    return { ok: true, available: true, text, totalChars: text.length }
  } catch {
    return { ok: false, available: true, error: 'extract-failed' }
  }
}

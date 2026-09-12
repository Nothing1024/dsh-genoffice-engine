/**
 * Isolated web print executor. Chromium printToPDF via Playwright — no Electron GUI.
 * Jobs are cancelable; dest is written only after a valid %PDF payload.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const jobs = new Map()

export function printReady() {
  if (process.env.GENOFFICE_PRINT_DISABLED === '1') {
    return { available: false, reason: 'print-service-disabled' }
  }
  try {
    const exe = chromium.executablePath()
    if (!exe || existsSync(exe) === false) return { available: false, reason: 'chromium-missing' }
    return { available: true, executor: 'playwright-chromium' }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function publicJob(job) {
  return {
    ok: job.status === 'success',
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    dest: job.dest,
    app: job.app,
    error: job.error,
    canceled: job.canceled,
    available: true,
    base64: job.base64 ?? null,
  }
}

export function getPrintJob(id) {
  const job = jobs.get(String(id ?? ''))
  return job ? publicJob(job) : null
}

export function cancelPrintJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: 'unknown job' }
  job.canceled = true
  if (job.browser) job.browser.close().catch(() => {})
  if (job.status === 'queued' || job.status === 'running') {
    job.status = 'cancelled'
    job.error = 'cancelled'
  }
  return { ...publicJob(job), ok: true }
}

export function startPrintJob(input = {}) {
  const ready = printReady()
  if (ready.available !== true) {
    return { ok: false, available: false, error: ready.reason }
  }
  const returnBytes = input.returnBytes === true
  const dest = typeof input.dest === 'string' ? input.dest : ''
  if (returnBytes === false && (dest.startsWith('/') === false || dest.includes('..'))) {
    return { ok: false, error: 'invalid dest' }
  }
  const html = typeof input.html === 'string' ? input.html : ''
  const pdfBase64 = typeof input.pdfBase64 === 'string' ? input.pdfBase64 : ''
  const pngs = Array.isArray(input.pngsBase64) ? input.pngsBase64.filter((item) => typeof item === 'string') : []
  const pdfs = Array.isArray(input.pdfsBase64) ? input.pdfsBase64.filter((item) => typeof item === 'string') : []
  if (html.length === 0 && pdfBase64.length === 0 && pngs.length === 0 && pdfs.length === 0) {
    return { ok: false, error: 'missing print payload' }
  }
  const id = randomUUID()
  const job = {
    id,
    status: 'queued',
    progress: 0,
    dest,
    app: typeof input.app === 'string' ? input.app : 'docs',
    canceled: false,
    error: null,
    browser: null,
    base64: null,
    returnBytes,
  }
  jobs.set(id, job)
  job.promise = runJob(job, { ...input, html, pdfBase64, pngsBase64: pngs, pdfsBase64: pdfs, returnBytes })
  return { ...publicJob(job), ok: true }
}

export async function waitPrintJob(id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: 'unknown job' }
  while (Date.now() < deadline) {
    if (job.status === 'success' || job.status === 'error' || job.status === 'cancelled') {
      return publicJob(job)
    }
    await Promise.race([job.promise.catch(() => {}), delay(40)])
  }
  return { ok: false, error: 'timeout', jobId: job.id, status: job.status }
}

async function runJob(job, input) {
  job.status = 'running'
  job.progress = 10
  try {
    const hold = Number(process.env.GENOFFICE_PRINT_HOLD_MS ?? input.holdMs ?? 0)
    if (hold > 0) await delay(hold)
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    let bytes
    if (input.pdfsBase64?.length > 0) {
      bytes = await mergePdfBytes(input.pdfsBase64)
      job.progress = 80
    } else if (input.pdfBase64) {
      bytes = Buffer.from(input.pdfBase64, 'base64')
      job.progress = 80
    } else if (input.pngsBase64.length > 0) {
      bytes = await htmlToPdf(job, pngDeckHtml(input.pngsBase64, input.widthPx, input.heightPx), {
        pageWidthTwips: pxToTwips(input.widthPx, 1280),
        pageHeightTwips: pxToTwips(input.heightPx, 720),
      })
    } else {
      bytes = await htmlToPdf(job, input.html, input)
    }
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    if (!bytes || bytes.length < 5 || bytes.subarray(0, 4).toString() !== '%PDF') {
      job.status = 'error'
      job.error = 'empty-or-invalid-pdf'
      return
    }
    job.base64 = bytes.toString('base64')
    if (input.returnBytes !== true) {
      await mkdir(dirname(job.dest), { recursive: true })
      await writeFile(job.dest, bytes)
    }
    job.progress = 100
    job.status = 'success'
  } catch (error) {
    if (job.canceled || (error instanceof Error && error.message === 'cancelled')) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    job.status = 'error'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.browser = null
  }
}

function pxToTwips(px, fallback) {
  const n = Number(px)
  return ((n > 0 ? n : fallback) / 96) * 1440
}

function pngDeckHtml(pngs, widthPx, heightPx) {
  const w = Number(widthPx) > 0 ? Number(widthPx) : 1280
  const h = Number(heightPx) > 0 ? Number(heightPx) : 720
  const pages = pngs.map((b64, i) => {
    const br = i === pngs.length - 1 ? 'auto' : 'always'
    return `<div style="page-break-after:${br};width:${w}px;height:${h}px"><img src="data:image/png;base64,${b64}" width="${w}" height="${h}"></div>`
  })
  return `<!doctype html><html><head><style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0}</style></head><body>${pages.join('')}</body></html>`
}

async function htmlToPdf(job, html, input) {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--no-sandbox'] })
  job.browser = browser
  try {
    if (job.canceled) throw new Error('cancelled')
    const page = await browser.newPage()
    await page.setContent(String(html), { waitUntil: 'load', timeout: 30_000 })
    if (job.canceled) throw new Error('cancelled')
    const opts = {
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    }
    if (Number(input.pageWidthTwips) > 0 && Number(input.pageHeightTwips) > 0) {
      opts.width = `${Number(input.pageWidthTwips) / 1440}in`
      opts.height = `${Number(input.pageHeightTwips) / 1440}in`
    } else if (input.pageSize && typeof input.pageSize === 'object') {
      opts.width = `${input.pageSize.width}in`
      opts.height = `${input.pageSize.height}in`
    } else {
      opts.format = typeof input.pageSize === 'string' ? input.pageSize : 'A4'
    }
    if (input.landscape) opts.landscape = true
    if (input.margins) {
      opts.margin = {
        top: `${input.margins.top ?? 0}in`,
        bottom: `${input.margins.bottom ?? 0}in`,
        left: `${input.margins.left ?? 0}in`,
        right: `${input.margins.right ?? 0}in`,
      }
    }
    if (Number(input.scale) > 0) opts.scale = Number(input.scale)
    if (input.headerTemplate || input.footerTemplate) {
      opts.displayHeaderFooter = true
      opts.headerTemplate = input.headerTemplate ?? '<span></span>'
      opts.footerTemplate = input.footerTemplate ?? '<span></span>'
    }
    const pdf = await page.pdf(opts)
    return Buffer.from(pdf)
  } finally {
    await browser.close().catch(() => {})
    job.browser = null
  }
}

async function mergePdfBytes(parts) {
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.create()
  for (const part of parts) {
    const src = await PDFDocument.load(Buffer.from(part, 'base64'))
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const page of pages) out.addPage(page)
  }
  return Buffer.from(await out.save())
}

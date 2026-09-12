/**
 * Isolated web OCR executor. Reuses the pdf2docx platform helper
 * (macOS Vision / Windows.Media.Ocr) — no second recognition algorithm.
 * Jobs are cancelable; dest is written only after a non-empty text result.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const jobs = new Map()

function defaultHelperPath() {
  if (process.env.GENOFFICE_OCR_HELPER) return process.env.GENOFFICE_OCR_HELPER
  if (process.platform === 'darwin') return join(ROOT, 'packages/pdf2docx/ocr-helper/vision-ocr')
  if (process.platform === 'win32') return join(ROOT, 'packages/pdf2docx/ocr-helper/win-ocr.exe')
  return ''
}

function ensureHelper() {
  const helper = defaultHelperPath()
  if (helper && existsSync(helper)) return helper
  if (process.platform === 'darwin') {
    const src = join(ROOT, 'packages/pdf2docx/ocr-helper/vision-ocr.swift')
    const dest = join(ROOT, 'packages/pdf2docx/ocr-helper/vision-ocr')
    if (existsSync(src)) {
      const compiled = spawnSync('swiftc', ['-O', '-o', dest, src], { timeout: 90_000 })
      if (compiled.status === 0 && existsSync(dest)) return dest
    }
  }
  return helper
}

function helperPath() {
  return ensureHelper()
}

function isPng(buf) {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
}

export function ocrReady() {
  if (process.env.GENOFFICE_OCR_DISABLED === '1') {
    return { available: false, reason: 'ocr-service-disabled' }
  }
  const helper = helperPath()
  if (!helper || existsSync(helper) === false) {
    return { available: false, reason: 'ocr-helper-missing' }
  }
  return { available: true, executor: 'platform-ocr-helper', helper }
}

function publicJob(job) {
  return {
    ok: job.status === 'success',
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    dest: job.dest,
    error: job.error,
    canceled: job.canceled,
    available: true,
    lines: job.lines ?? null,
    text: job.text ?? null,
  }
}

export function getOcrJob(id) {
  const job = jobs.get(String(id ?? ''))
  return job ? publicJob(job) : null
}

export function cancelOcrJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: 'unknown job' }
  job.canceled = true
  if (job.status === 'queued' || job.status === 'running') {
    job.status = 'cancelled'
    job.error = 'cancelled'
  }
  return { ...publicJob(job), ok: true }
}

export function startOcrJob(input = {}) {
  const ready = ocrReady()
  if (ready.available !== true) {
    return { ok: false, available: false, error: ready.reason }
  }
  const pngBase64 = typeof input.pngBase64 === 'string' ? input.pngBase64 : ''
  const dest = typeof input.dest === 'string' ? input.dest : ''
  if (pngBase64.length < 8) return { ok: false, error: 'missing ocr png' }
  if (dest && (dest.startsWith('/') === false || dest.includes('..'))) {
    return { ok: false, error: 'invalid dest' }
  }
  const id = randomUUID()
  const job = {
    id,
    status: 'queued',
    progress: 0,
    dest,
    canceled: false,
    error: null,
    lines: null,
    text: null,
    helper: ready.helper,
  }
  jobs.set(id, job)
  job.promise = runJob(job, { pngBase64, dest, holdMs: input.holdMs })
  return { ...publicJob(job), ok: true }
}

export async function waitOcrJob(id, timeoutMs = 60_000) {
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
    const hold = Number(process.env.GENOFFICE_OCR_HOLD_MS ?? input.holdMs ?? 0)
    if (hold > 0) await delay(hold)
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    if (process.env.GENOFFICE_OCR_FAIL === '1') {
      job.status = 'error'
      job.error = 'ocr-runtime-error'
      return
    }
    const png = Buffer.from(input.pngBase64, 'base64')
    if (isPng(png) === false) {
      job.status = 'error'
      job.error = 'invalid-png'
      return
    }
    const res = spawnSync(job.helper, [], {
      input: png,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    })
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    if (res.status !== 0 || res.stdout == null) {
      job.status = 'error'
      job.error = res.stderr?.toString('utf8')?.trim() || `ocr-helper-exit-${res.status}`
      return
    }
    let parsed
    try {
      parsed = JSON.parse(res.stdout.toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
      job.status = 'error'
      job.error = 'ocr-json-invalid'
      return
    }
    if (!Array.isArray(parsed.lines)) {
      job.status = 'error'
      job.error = 'ocr-empty-result'
      return
    }
    const lines = parsed.lines.map((line) => ({
      text: String(line.t ?? ''),
      confidence: Number(line.c ?? 0),
      box: Array.isArray(line.b) ? line.b : [0, 0, 0, 0],
      ...(Array.isArray(line.chars)
        ? {
            chars: line.chars.map((c) => ({
              text: String(c.t ?? ''),
              box: Array.isArray(c.b) ? c.b : [0, 0, 0, 0],
            })),
          }
        : {}),
    }))
    const text = lines.map((l) => l.text).join('\n').trim()
    job.lines = lines
    job.text = text
    job.progress = 80
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    if (input.dest) {
      if (!text) {
        job.status = 'error'
        job.error = 'ocr-empty-result'
        return
      }
      await mkdir(dirname(input.dest), { recursive: true })
      if (input.dest.endsWith('.md')) {
        await writeFile(input.dest, `# OCR\n\n${text}\n`, 'utf8')
      } else {
        await writeFile(input.dest, text, 'utf8')
      }
    }
    job.progress = 100
    job.status = 'success'
  } catch (error) {
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    job.status = 'error'
    job.error = error instanceof Error ? error.message : String(error)
  }
}

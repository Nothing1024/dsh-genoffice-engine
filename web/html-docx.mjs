/**
 * HTML → Word relay. Reuses the official html2docx CLI (Vite SSR + Playwright
 * driver). Dest is written only after a valid OOXML zip is produced.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from './write-atomic.mjs'

const ENGINE = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = join(ENGINE, 'packages/html2docx/tools/cli.ts')
const jobs = new Map()

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

export function htmlDocxReady() {
  if (process.env.GENOFFICE_HTML_DOCX_DISABLED === '1') {
    return { available: false, reason: 'html-docx-disabled' }
  }
  if (!existsSync(CLI)) return { available: false, reason: 'html2docx-cli-missing' }
  if (!findChrome()) return { available: false, reason: 'chrome-missing' }
  return { available: true, executor: 'html2docx-cli' }
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
  }
}

export function getHtmlDocxJob(id) {
  const job = jobs.get(String(id ?? ''))
  return job ? publicJob(job) : null
}

export function cancelHtmlDocxJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: 'unknown job' }
  job.canceled = true
  if (job.child) {
    try {
      job.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  if (job.status === 'queued' || job.status === 'running') {
    job.status = 'cancelled'
    job.error = 'cancelled'
  }
  return { ...publicJob(job), ok: true }
}

function looksLikeHtml(html) {
  return /<\s*(html|body|div|p|h[1-6]|span|section|article|table|ul|ol)\b/i.test(html)
}

function blockedExternal(html) {
  return /(?:src|href)\s*=\s*["'](?:file:|javascript:|data:text\/html)/i.test(html)
}

export function startHtmlDocxJob(input = {}) {
  const ready = htmlDocxReady()
  if (ready.available !== true) {
    return { ok: false, available: false, error: ready.reason }
  }
  const dest = typeof input.dest === 'string' ? input.dest : ''
  if (!dest.startsWith('/') || dest.includes('..')) {
    return { ok: false, error: 'invalid dest' }
  }
  const html = typeof input.html === 'string' ? input.html : ''
  if (!looksLikeHtml(html)) {
    return { ok: false, error: 'invalid-html', available: true }
  }
  if (blockedExternal(html)) {
    return { ok: false, error: 'blocked-external-resource', available: true }
  }
  const id = randomUUID()
  const job = {
    id,
    status: 'queued',
    progress: 0,
    dest,
    canceled: false,
    error: null,
    child: null,
    holdMs: Number(input.holdMs ?? 0),
  }
  jobs.set(id, job)
  job.promise = runJob(job, html)
  return { ...publicJob(job), ok: true }
}

export async function waitHtmlDocxJob(id, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: 'unknown job' }
  while (Date.now() < deadline) {
    if (job.status === 'success' || job.status === 'error' || job.status === 'cancelled') {
      return publicJob(job)
    }
    await Promise.race([job.promise.catch(() => {}), delay(80)])
  }
  return { ok: false, error: 'timeout', jobId: job.id, status: job.status }
}

async function runJob(job, html) {
  job.status = 'running'
  job.progress = 10
  const hold = Number(process.env.GENOFFICE_HTML_DOCX_HOLD_MS ?? job.holdMs ?? 0)
  if (hold > 0) await delay(hold)
  if (job.canceled) {
    job.status = 'cancelled'
    job.error = 'cancelled'
    return
  }
  const workDir = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'genoffice-html-docx-'))
  const inputPath = join(workDir, 'export.html')
  const tmpOut = join(workDir, 'out.docx')
  try {
    if (process.env.GENOFFICE_HTML_DOCX_FAIL === '1') {
      throw new Error('html-docx-fail')
    }
    if (job.canceled) throw new Error('cancelled')
    await writeFile(inputPath, html, 'utf8')
    job.progress = 30
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CLI, inputPath, tmpOut], {
        cwd: ENGINE,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      job.child = child
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('exit', (exitCode, signal) => {
        job.child = null
        if (job.canceled || signal === 'SIGTERM' || signal === 'SIGKILL') {
          resolveCode(-1)
          return
        }
        if (exitCode !== 0) {
          reject(new Error(stderr.trim() || `html2docx-exit-${exitCode}`))
          return
        }
        resolveCode(0)
      })
    })
    if (job.canceled || code !== 0) {
      job.status = 'cancelled'
      job.error = 'cancelled'
      return
    }
    const bytes = await readFile(tmpOut)
    if (bytes.length < 4 || bytes.subarray(0, 2).toString() !== 'PK') {
      throw new Error('html-docx-invalid-output')
    }
    const written = await writeFileAtomic(job.dest, bytes, undefined, { overwrite: true })
    if (!written.ok) throw new Error(written.error ?? 'write-failed')
    job.progress = 100
    job.status = 'success'
  } catch (error) {
    if (job.canceled) {
      job.status = 'cancelled'
      job.error = 'cancelled'
    } else {
      job.status = 'error'
      job.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

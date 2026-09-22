/**
 * Atomic write-back helpers for the GenOffice web relay (INV-002 / BR-004).
 * Extracted so dest preflight and error-code mapping can be unit-tested
 * without starting the HTTP server.
 */
import { link, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/** Stable short codes for the disk errors the UI must show (UF-001 write-fail). */
export function diskError(e) {
  const code = e && typeof e === 'object' && typeof e.code === 'string' ? e.code : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return code
  return e instanceof Error ? e.message : String(e)
}

/**
 * Probe whether `absPath` can host an atomic write (same-dir wx tmp).
 * exclusive + dest exists → `exists` without touching dest bytes.
 */
export async function preflightDest(absPath, exclusive = false) {
  const parent = dirname(absPath)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return { ok: false, error: `parent directory does not exist: ${parent}` }
  }
  if (exclusive && existsSync(absPath)) {
    return { ok: false, error: 'exists' }
  }
  const probe = join(parent, `.genoffice-write-${randomUUID()}.tmp`)
  try {
    await writeFile(probe, Buffer.alloc(0), { flag: 'wx' })
  } catch (e) {
    return { ok: false, error: diskError(e) }
  } finally {
    try {
      await rm(probe, { force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
  return { ok: true }
}

export function fileRevision(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

const writeQueues = new Map()
function enqueueWrite(key, fn) {
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  writeQueues.set(key, run.catch(() => {}))
  return run
}

/** atomic write-back: tmp in the same directory + rename (BR-004, INV-003).
 *  exclusive: skip mtime, wx tmp then link(tmp, dest); EEXIST → exists; never overwrite dest. */
export async function writeFileAtomic(absPath, buf, expectedMtimeMs, opts = {}) {
  return enqueueWrite(resolve(absPath), () => writeFileAtomicUnqueued(absPath, buf, expectedMtimeMs, opts))
}

async function writeFileAtomicUnqueued(absPath, buf, expectedMtimeMs, opts = {}) {
  const exclusive = opts.exclusive === true
  const parent = dirname(absPath)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return { ok: false, error: `parent directory does not exist: ${parent}` }
  }
  const tmpPath = join(parent, `.genoffice-write-${randomUUID()}.tmp`)
  try {
    await writeFile(tmpPath, buf, { flag: 'wx' })
    if (exclusive) {
      try {
        await link(tmpPath, absPath)
      } catch (e) {
        if (e && typeof e === 'object' && e.code === 'EEXIST') {
          return { ok: false, error: 'exists' }
        }
        throw e
      }
      return { ok: true }
    }
    if (existsSync(absPath)) {
      let st = null
      try {
        st = statSync(absPath)
      } catch {
        st = null
      }
      const expectedRev = opts.expectedRevision
      if (typeof expectedRev === 'string' && expectedRev !== '') {
        const current = fileRevision(await readFile(absPath))
        if (current !== expectedRev) return { ok: false, error: 'conflict' }
      } else if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
        if (!st || Number(st.mtimeMs) !== Number(expectedMtimeMs)) {
          return { ok: false, error: 'conflict' }
        }
      } else {
        return { ok: false, error: 'conflict' }
      }
    }
    await rename(tmpPath, absPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: diskError(e) }
  } finally {
    try {
      await rm(tmpPath, { force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
}

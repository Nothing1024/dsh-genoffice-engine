/**
 * Isolated markdown sibling-asset writes. Official desktop copies images into
 * `<docDir>/assets/` and authors a relative `assets/<name>` path. Web uses the
 * same directory contract and the existing atomic write helper.
 */
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { writeFileAtomic } from './write-atomic.mjs'

const ALLOWED = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
])

export function assetsReady() {
  if (process.env.GENOFFICE_MARKDOWN_ASSETS_DISABLED === '1') {
    return { available: false, reason: 'markdown-assets-disabled' }
  }
  return { available: true }
}

function sanitizeName(preferred) {
  const ext = extname(preferred).toLowerCase()
  const mime = ALLOWED.get(ext)
  if (!mime) return null
  const stem = preferred
    .slice(0, Math.max(0, preferred.length - ext.length))
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60) || 'image'
  return { name: `${stem}${ext}`, ext, mime }
}

function isPathInside(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolved = resolve(candidate)
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep)
}

export async function saveMarkdownAsset(body) {
  const ready = assetsReady()
  if (!ready.available) return { ok: false, available: false, error: ready.reason }
  if (process.env.GENOFFICE_MARKDOWN_ASSETS_FAIL === '1') {
    return { ok: false, available: true, error: 'markdown-assets-fail' }
  }
  const documentPath = typeof body?.documentPath === 'string' ? body.documentPath : ''
  if (!documentPath || !isAbsolute(documentPath)) return { ok: false, error: 'missing-document-path' }
  const preferred = typeof body?.name === 'string' ? body.name : `image.${body?.ext || 'png'}`
  const safe = sanitizeName(preferred.startsWith('.') ? `image${preferred}` : preferred)
  if (!safe) return { ok: false, error: 'unsupported-image-ext' }
  if (typeof body?.bytesBase64 !== 'string' || !body.bytesBase64) return { ok: false, error: 'missing-bytes' }
  let bytes
  try {
    bytes = Buffer.from(body.bytesBase64, 'base64')
  } catch {
    return { ok: false, error: 'invalid-base64' }
  }
  if (bytes.length === 0) return { ok: false, error: 'empty-image' }
  const assetsDir = join(dirname(documentPath), 'assets')
  await mkdir(assetsDir, { recursive: true })
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const name = suffix === 0 ? safe.name : `${safe.name.slice(0, -safe.ext.length)}-${suffix}${safe.ext}`
    const target = join(assetsDir, name)
    if (existsSync(target)) continue
    const written = await writeFileAtomic(target, bytes, null, { exclusive: true })
    if (!written.ok) {
      if (written.error === 'exists') continue
      return { ok: false, error: written.error }
    }
    return { ok: true, available: true, relative: `assets/${name}`, path: target }
  }
  return { ok: false, error: 'asset-name-space-exhausted' }
}

export function resolveMarkdownAsset(documentPath, source) {
  if (!documentPath || !isAbsolute(documentPath) || typeof source !== 'string') return null
  const trimmed = source.trim()
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null
  }
  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    return null
  }
  const documentDir = dirname(resolve(documentPath))
  const candidate = resolve(documentDir, decoded.replace(/[\\/]/g, sep))
  if (!isPathInside(documentDir, candidate)) return null
  const mime = ALLOWED.get(extname(candidate).toLowerCase())
  if (!mime) return null
  return { path: candidate, mime }
}

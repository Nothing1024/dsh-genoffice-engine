/**
 * Isolated web Docs crypto boundary. Reuses officecrypto-tool (same
 * implementation as apps/docs/src/main/docx-encryption.ts). Passwords never
 * appear in logs or public results. Dest is written only after a successful
 * encrypt/decrypt.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { preflightDest, writeFileAtomic } from './write-atomic.mjs'

const require = createRequire(import.meta.url)
const officeCrypto = require('officecrypto-tool')

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

export function isEncryptedDocx(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return buf.length >= 8 && buf.subarray(0, 8).equals(CFB_MAGIC) && buf.includes(ENCRYPTED_STREAM_UTF16)
}

export function cryptoReady() {
  if (process.env.GENOFFICE_DOCS_CRYPTO_DISABLED === '1') {
    return { available: false, reason: 'docs-crypto-disabled' }
  }
  try {
    require.resolve('officecrypto-tool')
    return { available: true, executor: 'officecrypto-tool' }
  } catch {
    return { available: false, reason: 'officecrypto-missing' }
  }
}

function failReason(err) {
  const message = String(err?.message ?? err)
  if (message.toLowerCase().includes('password is incorrect')) return 'wrong-password'
  if (message === 'wrong-password') return 'wrong-password'
  if (message === 'unsupported') return 'unsupported'
  return 'error'
}

function publicError(reason, fallback) {
  if (reason === 'wrong-password') return 'wrong-password'
  if (reason === 'unsupported') return 'unsupported'
  return fallback || 'docs-crypto-failed'
}

function bytesFromBody(body) {
  if (typeof body?.bytesBase64 === 'string' && body.bytesBase64) {
    return Buffer.from(body.bytesBase64, 'base64')
  }
  const path = typeof body?.path === 'string' ? body.path : ''
  if (!path || !isAbsolute(path) || !existsSync(path)) return null
  return readFileSync(path)
}

async function maybeWriteDest(dest, buf) {
  if (typeof dest !== 'string' || !dest) return { dest: undefined }
  const probe = await preflightDest(dest)
  if (!probe.ok) return { error: probe.error }
  const written = await writeFileAtomic(dest, buf, null, { overwrite: true })
  if (!written.ok) return { error: written.error }
  return { dest }
}

export async function decryptDocxRequest(body) {
  const ready = cryptoReady()
  if (!ready.available) {
    return { ok: false, available: false, reason: 'unsupported', error: ready.reason }
  }
  if (process.env.GENOFFICE_DOCS_CRYPTO_FAIL === '1') {
    return { ok: false, available: true, reason: 'error', error: 'docs-crypto-fail' }
  }
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password) return { ok: false, reason: 'error', error: 'missing-password' }
  const bytes = bytesFromBody(body)
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'error', error: 'missing-bytes' }
  if (!isEncryptedDocx(bytes)) return { ok: false, reason: 'unsupported', error: 'not-encrypted' }
  try {
    const plain = await officeCrypto.decrypt(bytes, { password })
    if (!plain || plain.length === 0) return { ok: false, reason: 'error', error: 'empty-decrypt' }
    const destResult = await maybeWriteDest(body?.dest, Buffer.from(plain))
    if (destResult.error) return { ok: false, reason: 'error', error: destResult.error }
    return {
      ok: true,
      available: true,
      base64: Buffer.from(plain).toString('base64'),
      dest: destResult.dest,
    }
  } catch (err) {
    const reason = failReason(err)
    return { ok: false, available: true, reason, error: publicError(reason) }
  }
}

export async function encryptDocxRequest(body) {
  const ready = cryptoReady()
  if (!ready.available) {
    return { ok: false, available: false, reason: 'unsupported', error: ready.reason }
  }
  if (process.env.GENOFFICE_DOCS_CRYPTO_FAIL === '1') {
    return { ok: false, available: true, reason: 'error', error: 'docs-crypto-fail' }
  }
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password) return { ok: false, reason: 'error', error: 'missing-password' }
  const bytes = bytesFromBody(body)
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'error', error: 'missing-bytes' }
  if (isEncryptedDocx(bytes)) return { ok: false, reason: 'error', error: 'already-encrypted' }
  try {
    const encrypted = officeCrypto.encrypt(bytes, { password })
    if (!encrypted || encrypted.length === 0) return { ok: false, reason: 'error', error: 'empty-encrypt' }
    const destResult = await maybeWriteDest(body?.dest, Buffer.from(encrypted))
    if (destResult.error) return { ok: false, reason: 'error', error: destResult.error }
    return {
      ok: true,
      available: true,
      base64: Buffer.from(encrypted).toString('base64'),
      dest: destResult.dest,
    }
  } catch (err) {
    const reason = failReason(err)
    return { ok: false, available: true, reason, error: publicError(reason) }
  }
}

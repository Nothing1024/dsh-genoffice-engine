/**
 * Browser shims for Node builtins used by the xlsx gateway (web build only).
 *
 * The desktop save pipeline (`apps/sheets/src/gateway/xlsx-gateway.ts`) is
 * pure JSZip + XML manipulation; its only Node imports are:
 *
 *   - `node:crypto`  createHash (sha256 of archive entries — inventory)
 *   - `node:fs/promises` + `node:path` — file-persisting helpers the browser
 *     path never calls (writeXlsxAtomically / syncFileBestEffort / …)
 *
 * vite.web.config.ts aliases those specifiers to this file so the same
 * gateway code runs in the browser bundle. `Buffer` is installed as a
 * global (JSZip's `nodebuffer` output type checks `typeof Buffer`).
 *
 * This file is only reachable through the web build; the desktop build never
 * imports it.
 */

// ── Buffer (minimal subset used by jszip + gateway) ─────────────────────

export class WebBuffer extends Uint8Array {
  static from(value: unknown, encodingOrOffset?: unknown, length?: unknown): WebBuffer {
    if (typeof value === 'string') {
      const encoding = typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8'
      const bytes = encodeString(value, encoding)
      return WebBuffer.fromBytes(bytes)
    }
    if (value instanceof ArrayBuffer) {
      return new WebBuffer(value)
    }
    if (ArrayBuffer.isView(value)) {
      return new WebBuffer(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength)
    }
    if (Array.isArray(value)) {
      return WebBuffer.fromBytes(Uint8Array.from(value as number[]))
    }
    throw new Error('WebBuffer.from: unsupported input')
  }

  static fromBytes(bytes: Uint8Array): WebBuffer {
    const buf = new WebBuffer(bytes.byteLength)
    buf.set(bytes)
    return buf
  }

  static alloc(size: number): WebBuffer {
    return new WebBuffer(size)
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): WebBuffer {
    const total = totalLength ?? list.reduce((sum, part) => sum + part.byteLength, 0)
    const out = new WebBuffer(total)
    let offset = 0
    for (const part of list) {
      out.set(part, offset)
      offset += part.byteLength
    }
    return out
  }

  static isBuffer(value: unknown): value is WebBuffer {
    return value instanceof WebBuffer
  }

  static byteLength(value: string, encoding?: string): number {
    return encodeString(value, encoding ?? 'utf8').byteLength
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const slice = this.subarray(start ?? 0, end ?? this.length)
    return decodeString(slice, encoding ?? 'utf8')
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: [...this] }
  }
}

function encodeString(value: string, encoding: string): Uint8Array {
  if (encoding === 'base64') {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  if (encoding === 'hex') {
    const bytes = new Uint8Array(Math.ceil(value.length / 2))
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
  }
  // utf8 / utf-8 / latin1 / binary (byte-preserving fallback for binary)
  return new TextEncoder().encode(value)
}

function decodeString(bytes: Uint8Array, encoding: string): string {
  if (encoding === 'base64') {
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  if (encoding === 'hex') {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return new TextDecoder('utf-8').decode(bytes)
}

// Installed at module scope: the alias module is imported before the gateway
// (and therefore before JSZip) in the web bridge's import order, so JSZip's
// `support.nodebuffer` check sees a defined Buffer. @types/node's own global
// Buffer declaration is left untouched (no `declare global` here).
;(globalThis as unknown as { Buffer: unknown }).Buffer = WebBuffer

/** named export for `import { Buffer } from 'node:buffer'` (jszip compat) */
export { WebBuffer as Buffer }

// ── node:crypto shim — synchronous SHA-256 (archive inventory) ──────────

function sha256Bytes(message: Uint8Array): Uint8Array {
  // SHA-256 (FIPS 180-4), 64-byte blocks, big-endian words
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  const length = message.byteLength
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6)
  padded.set(message)
  padded[length] = 0x80
  const bitLen = length * 8
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  const w = new Int32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(block + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let a = H[0]!
    let b = H[1]!
    let c = H[2]!
    let d = H[3]!
    let e = H[4]!
    let f = H[5]!
    let g = H[6]!
    let h = H[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K256[i]! + w[i]!) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    H[0] = (H[0]! + a) | 0
    H[1] = (H[1]! + b) | 0
    H[2] = (H[2]! + c) | 0
    H[3] = (H[3]! + d) | 0
    H[4] = (H[4]! + e) | 0
    H[5] = (H[5]! + f) | 0
    H[6] = (H[6]! + g) | 0
    H[7] = (H[7]! + h) | 0
  }
  const out = new Uint8Array(32)
  const outDv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i]!)
  return out
}

export interface SyncHash {
  update(data: Uint8Array | string): SyncHash
  digest(encoding?: 'hex'): string
}

export function createHash(_algorithm: string): SyncHash {
  const chunks: Uint8Array[] = []
  return {
    update(data: Uint8Array | string) {
      chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      return this
    },
    digest(encoding?: 'hex') {
      const digest = sha256Bytes(WebBuffer.concat(chunks))
      if (encoding === 'hex') {
        return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
      }
      return [...digest].map((b) => String.fromCharCode(b)).join('')
    },
  }
}

// ── node:fs/promises + node:path + node:os + node:zlib shims ─────────────
// The gateway's file-persisting helpers are browser-unreachable; named
// exports keep the import shape so the same TS source bundles unchanged.

function nodeOnly(name: string): never {
  throw new Error(`[web] node:${name} is unavailable in the browser build (sheets web bridge)`)
}

export const open = (): never => nodeOnly('fs/promises.open')
export const readFile = (): never => nodeOnly('fs/promises.readFile')
export const rename = (): never => nodeOnly('fs/promises.rename')
export const rm = (): never => nodeOnly('fs/promises.rm')
export const writeFile = (): never => nodeOnly('fs/promises.writeFile')
export const mkdir = (): never => nodeOnly('fs/promises.mkdir')
export const mkdtemp = (): never => nodeOnly('fs/promises.mkdtemp')

// node:fs sync API (gateway writeXlsxAtomically / syncFileBestEffort — browser-unreachable)
export const openSync = (): never => nodeOnly('fs.openSync')
export const closeSync = (): never => nodeOnly('fs.closeSync')
export const fsyncSync = (): never => nodeOnly('fs.fsyncSync')
export const readFileSync = (): never => nodeOnly('fs.readFileSync')
export const writeFileSync = (): never => nodeOnly('fs.writeFileSync')

export const dirname = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
export const join = (...parts: string[]): string => parts.join('/')
export const resolve = (p: string): string => p
export const tmpdir = (): string => '/tmp'
export const deflateSync = (): never => nodeOnly('zlib.deflateSync')
export const deflateRawSync = (): never => nodeOnly('zlib.deflateRawSync')
export const randomUUID = (): string => crypto.randomUUID()

export const fsPromisesShim = { open, readFile, rename, rm, writeFile, mkdir, mkdtemp }
export const pathShim = { dirname, join, resolve }
export const osShim = { tmpdir }
export const zlibShim = { deflateSync, deflateRawSync }
export const cryptoShim = { createHash }

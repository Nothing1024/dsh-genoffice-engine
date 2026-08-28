import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { fontCoversText } from '../src/renderer/web-font-cmap'
import { WebBuffer } from '../src/renderer/web-node-shims'

/** the face the browser build embeds for rebuilt and inserted runs (EDIT_FONT_URLS.regular) */
const LIBERATION_SANS = createRequire(`${process.cwd()}/`)
  .resolve('pdfjs-dist/package.json')
  .replace(/package\.json$/, 'standard_fonts/LiberationSans-Regular.ttf')

/** what web-text-edit's asFontBuffer does with the bytes fetch() returns */
const asFontBuffer = (bytes: Uint8Array): Buffer => WebBuffer.from(bytes) as unknown as Buffer

describe('web Buffer shim feeding the sfnt readers', () => {
  it('reads a real cmap, so browser text edits are not rejected as undrawable', () => {
    const bytes = new Uint8Array(readFileSync(LIBERATION_SANS))
    expect(fontCoversText(asFontBuffer(bytes), 'Revenue grew 12% in Q3')).toBe(true)
    expect(fontCoversText(asFontBuffer(bytes), '应付金额')).toBe(false)
    // Why asFontBuffer copies instead of casting: fetch() hands the edit path a plain
    // Uint8Array, and the missing readUInt16BE made fontCoversText answer "no available
    // font can draw this" for every replacement, plain ASCII included.
    expect(fontCoversText(bytes as unknown as Buffer, 'Revenue grew 12% in Q3')).toBe(false)
  })

  it('copies views like Buffer.from does, so cached font bytes survive a rewrite', () => {
    const cached = Uint8Array.from([0x4f, 0x54, 0x54, 0x4f])
    const copy = WebBuffer.from(cached.subarray(0, 4))
    copy[0] = 0x00
    expect([...cached]).toEqual([0x4f, 0x54, 0x54, 0x4f])
  })

  it('keeps latin1 one char per byte, which is how table tags are compared', () => {
    expect(WebBuffer.from([0x63, 0x6d, 0x61, 0x70]).toString('latin1')).toBe('cmap')
    // utf-8 decoding folded every byte >= 0x80 into U+FFFD and shifted the tag compare
    expect(WebBuffer.from([0x80, 0xff]).toString('latin1')).toBe('\u0080\u00ff')
    expect([...WebBuffer.from('\u0080\u00ff', 'latin1')]).toEqual([0x80, 0xff])
  })

  it('reads the signed and multi-byte integers the cmap and CFF readers use', () => {
    const buf = WebBuffer.from([0xff, 0xf0, 0x00, 0x01, 0x02])
    expect(buf.readInt16BE(0)).toBe(-16)
    expect(buf.readUInt16BE(0)).toBe(0xfff0)
    expect(buf.readUIntBE(2, 3)).toBe(0x000102)
    buf.writeUInt16BE(0x0102, 0)
    expect(buf.readUInt16BE(0)).toBe(0x0102)
  })
})

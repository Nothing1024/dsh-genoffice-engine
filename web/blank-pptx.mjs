/**
 * Blank presentation bytes for POST /api/pptx/create.
 *
 * Part XML comes from the engine's blank-parts.mjs. This file only packs
 * those parts into a deflate zip, because the relay does not depend on JSZip.
 */
import { deflateRawSync } from 'node:zlib'
import { BLANK_PPTX_PARTS } from '../packages/pptx-engine/src/blank-parts.mjs'

const FILES = BLANK_PPTX_PARTS


function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function le(n, bytes) {
  const b = Buffer.alloc(bytes)
  if (bytes === 2) b.writeUInt16LE(n)
  else b.writeUInt32LE(n >>> 0)
  return b
}

/** Deflate zip with the parts createBlankPptx writes. No extra fields. */
export function blankPptxBytes() {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, body] of FILES) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(body)
    const comp = deflateRawSync(raw)
    const crc = crc32(raw)
    const local = Buffer.concat([
      le(0x04034b50, 4), le(20, 2), le(0, 2), le(8, 2), le(0, 2), le(0, 2),
      le(crc, 4), le(comp.length, 4), le(raw.length, 4),
      le(nameBuf.length, 2), le(0, 2), nameBuf, comp,
    ])
    centrals.push(Buffer.concat([
      le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(8, 2), le(0, 2), le(0, 2),
      le(crc, 4), le(comp.length, 4), le(raw.length, 4),
      le(nameBuf.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4),
      le(offset, 4), nameBuf,
    ]))
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([
    le(0x06054b50, 4), le(0, 2), le(0, 2), le(FILES.length, 2), le(FILES.length, 2),
    le(central.length, 4), le(offset, 4), le(0, 2),
  ])
  return Buffer.concat([...locals, central, end])
}

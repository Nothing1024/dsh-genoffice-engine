/**
 * Blank presentation template — starting point for the start screen's
 * "AI generate / New blank" actions. The OOXML parts live in blank-parts.mjs
 * so the relay zip writer uses the same bytes. Once parsed by openPptx the
 * deck goes through the same edit/save pipeline as opening a real file.
 */
import JSZip from 'jszip'
import { BLANK_PPTX_PARTS } from './blank-parts.mjs'

export { BLANK_PPTX_PARTS, BLANK_SLIDE_XML } from './blank-parts.mjs'

/** Generate blank presentation bytes (16:9, one blank slide). */
export async function createBlankPptx(): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, xml] of BLANK_PPTX_PARTS) zip.file(name, xml)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

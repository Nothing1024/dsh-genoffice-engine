/**
 * Browser wasm/font asset URLs for the pdf web save pipeline (web build only).
 * The desktop main process resolves these from disk (wasm-path.ts + system
 * fonts); the browser fetches the same npm-shipped assets through Vite's
 * `?url` imports.
 */
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import hbSubsetWasmUrl from 'harfbuzzjs/hb-subset.wasm?url'
import fallbackFontUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url'
import editFontRegularUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url'
import editFontBoldUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import editFontItalicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url'
import editFontBoldItalicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url'

export const PDFIUM_WASM_URL = pdfiumWasmUrl
export const HB_SUBSET_WASM_URL = hbSubsetWasmUrl
export const FALLBACK_FONT_URL = fallbackFontUrl
/** user-selectable rebuild fonts (desktop reads system fonts; browser bundles LiberationSans) */
export const EDIT_FONT_URLS: Record<'regular' | 'bold' | 'italic' | 'bolditalic', string> = {
  regular: editFontRegularUrl,
  bold: editFontBoldUrl,
  italic: editFontItalicUrl,
  bolditalic: editFontBoldItalicUrl,
}

let fontCache = new Map<string, Uint8Array>()

/** Fetch one asset as bytes (cached). */
export async function fetchAssetBytes(url: string): Promise<Uint8Array> {
  const cached = fontCache.get(url)
  if (cached) return cached
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`asset fetch failed: ${url}`)
  const bytes = new Uint8Array(await resp.arrayBuffer())
  fontCache.set(url, bytes)
  return bytes
}

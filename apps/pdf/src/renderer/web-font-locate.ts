/**
 * Browser font-locate shim (web build only): the desktop main process scans
 * system font directories; the browser has no system fonts, so the text-edit
 * pipeline falls back to the bundled LiberationSans face (web-wasm-assets.ts).
 *
 * The side-effect import installs `globalThis.Buffer` (web-node-shims) — it
 * must run before any module calls Buffer.from (the alias/type-only imports
 * get tree-shaken out of the bundle otherwise).
 */
import './web-node-shims'

export const isTruetype = (b: Uint8Array): boolean =>
  b.length >= 4 &&
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0) !== 0x4f54544f

/** No system fonts in the browser: always null (callers fall back to the bundled face). */
export function findSystemFont(_psName: string, _family: string): Buffer | null {
  return null
}

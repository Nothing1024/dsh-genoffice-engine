/**
 * URL flags for sheets web control mode. Read once at module load
 * (the open flow later clears `?open=` / `?control=` from the address bar).
 *
 * Kept as a tiny module so ExcelShell can hide the AI dock and apply the
 * `control-mode` layout class without importing the full SSE/save adapter
 * in `control.ts` (INV-002: this demand does not change the write-back contract).
 */
const params = new URLSearchParams(location.search)

/** BR-001: control mode active. */
export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

/** Original absolute path from the `path:` open target (BR-009 docId source). */
export const CONTROL_PATH: string | null = openTarget.startsWith('path:')
  ? openTarget.slice('path:'.length)
  : null

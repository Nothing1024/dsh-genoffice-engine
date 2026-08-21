/**
 * URL flags for sheets web control mode. Read once at module load
 * (the open flow later clears `?open=` / `?control=` from the address bar).
 */
const params = new URLSearchParams(location.search)

export const CONTROL_MODE = params.get('control') === '1'

const openTarget = params.get('open') ?? params.get('file') ?? ''

/** Absolute path from a `path:` open target, or null. */
export const CONTROL_PATH: string | null = openTarget.startsWith('path:')
  ? openTarget.slice('path:'.length)
  : null

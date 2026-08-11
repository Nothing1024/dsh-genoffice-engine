/**
 * Build config for the out-of-tree DSH client plugin.
 *
 * Reuses the DSH source tree's shared `clientBundle` preset so the browser
 * artifact (lib/client.js) matches the official shape exactly: a
 * closure-factory bundle handed to `window.__ModuleLoader__.load`, with the
 * platform modules (react/cordis/ui-slots/...) kept external against the
 * loader module table. The node-half lib build is spelled directly here
 * (entry = src/index.ts) instead of going through the preset's tsc
 * intermediate (lib/types/*.js), which requires the DSH workspace's project
 * references.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { createRequire } from 'node:module'
import { clientBundle } from '/Users/nothing/.dsh/source/current/packages/client/tsdown.client.ts'

// The bundle's loader id must equal the profile row's package name; the
// build overrides it via DSH_PLUGIN_ID when the row mounts a renamed copy
// (see the dsh-plugin-r2 runtime dir trick).
const PLUGIN_ID = process.env.DSH_PLUGIN_ID ?? 'dsh-genoffice-sidebar'
const [, clientConfig] = clientBundle(PLUGIN_ID, [])
const configRequire = createRequire(import.meta.url)

/** Vite-style `?raw` imports: the xterm stylesheet rides the bundle as text. */
const rawTextPlugin = {
  name: 'raw-text',
  resolveId(source: string) {
    if (source.endsWith('?raw')) {
      const target = source.slice(0, -4)
      // Bare specifier subpaths (xterm/css/xterm.css) resolve through the
      // package; absolute/relative paths pass through.
      const file = target.startsWith('.') || target.startsWith('/')
        ? resolvePath(process.cwd(), target)
        : configRequire.resolve(target)
      // `.txt` suffix: the tsdown css guard matches ids ending in `.css`.
      return `\0raw:${file}.txt`
    }
    return null
  },
  load(id: string) {
    if (id.startsWith('\0raw:')) return readFileSync(id.slice(5, -4), 'utf8')
    return null
  },
}
clientConfig.plugins = [...(clientConfig.plugins ?? []), rawTextPlugin]

/** Node half: ESM plugin entry the host Loader imports as the row's main. */
const libConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Peer/runtime deps resolve from the profile install (or the healed module
  // fallback): cordis stays external like every DSH plugin; ws + node-pty
  // are host-process libraries from the DSH closure, never bundled.
  external: ['cordis', 'react', 'ws', 'node-pty'],
}

export default [libConfig, clientConfig]

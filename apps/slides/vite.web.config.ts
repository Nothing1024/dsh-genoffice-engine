import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

/**
 * Web build for GenOffice Slides: the *unmodified* renderer plus the web
 * bridge (web-bridge.ts) injected before main.tsx. Node builtins used by
 * @genoffice/pptx-engine (node:crypto / node:zlib) are aliased to browser
 * shims (web-node-shims.ts) so the same byte-fidelity open/save/edit engine
 * runs in the browser.
 *
 *   npm run web:build -w @genoffice/slides → apps/slides/web-dist/
 *   npm run web:dev    -w @genoffice/slides → dev server
 */
function webBridgePlugin(): Plugin {
  return {
    name: 'genoffice-web-bridge',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const relaxedCsp = html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
          `<meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' https: wss: ws: http: data:"
        />`,
        )
        return relaxedCsp.replace(
          /<script type="module" src="\.?\/main\.tsx"><\/script>/,
          `<script type="module" src="./web-bridge.ts"></script>
    <script type="module" src="./main.tsx"></script>`,
        )
      },
    },
  }
}

const shims = path.resolve(__dirname, 'src/renderer/web-node-shims.ts')

export default defineConfig({
  root: 'src/renderer',
  // served under /slides/ by web/server.mjs — asset URLs must match
  base: '/slides/',
  plugins: [react(), webBridgePlugin()],
  resolve: {
    alias: [
      // Node builtins → browser shims (pptx-engine reuse; desktop build unaffected)
      { find: 'node:crypto', replacement: shims },
      { find: 'node:zlib', replacement: shims },
      { find: 'node:fs/promises', replacement: shims },
      { find: 'node:stream/promises', replacement: shims },
      { find: 'node:path', replacement: shims },
      { find: 'node:os', replacement: shims },
      { find: 'node:buffer', replacement: shims },
    ],
  },
  server: {
    port: Number(process.env.SLIDES_WEB_DEV_PORT) || 5175,
    strictPort: true,
    proxy: {
      // dev: the relay server runs on :8787; in the built app /api is same-origin
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
    target: 'es2022',
  },
})

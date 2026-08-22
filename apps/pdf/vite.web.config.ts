import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

/**
 * Web build for GenOffice PDF: the *unmodified* renderer plus the web bridge
 * (web-bridge.ts) injected before main.tsx. The save pipeline's Node bits
 * (node:fs / wasm-path / system fonts) are replaced by browser modules
 * (web-pdf-save.ts / web-text-edit.ts / web-wasm-assets.ts); pdfium.wasm,
 * hb-subset.wasm and the LiberationSans faces are bundled via `?url` imports.
 *
 *   npm run web:build -w @genoffice/pdf → apps/pdf/web-dist/
 *   npm run web:dev    -w @genoffice/pdf → dev server
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
          content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' https: wss: ws: http: data:"
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
  // served under /pdf/ by web/server.mjs — asset URLs must match
  base: '/pdf/',
  plugins: [react(), webBridgePlugin()],
  resolve: {
    alias: [
      // Node builtins → browser shims (only reachable through the ported web modules)
      { find: 'node:fs', replacement: shims },
      { find: 'node:fs/promises', replacement: shims },
      { find: 'node:path', replacement: shims },
      { find: 'node:os', replacement: shims },
      { find: 'node:crypto', replacement: shims },
      { find: 'node:buffer', replacement: shims },
    ],
  },
  server: {
    port: Number(process.env.PDF_WEB_DEV_PORT) || 5176,
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

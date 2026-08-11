import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

/**
 * Web build for GenOffice Docs: the *unmodified* renderer plus the web bridge
 * (web-bridge.ts) injected before main.tsx, with a CSP that allows browser
 * fetches to AI providers and the local relay server.
 *
 *   npm run web:build -w @genoffice/docs   → apps/docs/web-dist/
 *   npm run web:dev    -w @genoffice/docs   → dev server on :5173
 */
function webBridgePlugin(): Plugin {
  return {
    name: 'genoffice-web-bridge',
    // 'pre': must run before vite's own html plugin, which rewrites module
    // script tags into bundle entries in build mode
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
          '<script type="module" src="./main.tsx"></script>',
          `<script type="module" src="./web-bridge.ts"></script>
    <script type="module" src="./main.tsx"></script>`,
        )
      },
    },
  }
}

export default defineConfig({
  root: 'src/renderer',
  // served under /docs/ by web/server.mjs — asset URLs must match
  base: '/docs/',
  plugins: [react(), webBridgePlugin()],
  server: {
    port: Number(process.env.DOCS_WEB_DEV_PORT) || 5173,
    strictPort: true,
    proxy: {
      // dev: the relay server runs on :8787; in the built app /api is same-origin
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2022',
  },
})

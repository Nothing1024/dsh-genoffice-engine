import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

/**
 * Web build for the GenOffice shell (Home screen): the *unmodified* renderer
 * plus the web bridge (src/web-bridge.ts) injected before main.tsx.
 *
 *   npm run web:build -w @genoffice/shell   → apps/shell/web-dist/
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
          '<script type="module" src="/src/main.tsx"></script>',
          `<script type="module" src="/src/web-bridge.ts"></script>
    <script type="module" src="/src/main.tsx"></script>`,
        )
      },
    },
  }
}


function stubCodexAppServer(): Plugin {
  const stub = path.resolve(__dirname, '../../packages/ai-provider/src/codex-app-server.browser.ts')
  return {
    name: 'stub-codex-app-server-web',
    enforce: 'pre',
    resolveId(id) {
      if (id.includes('codex-app-server') && !id.includes('.browser')) return stub
      return undefined
    },
  }
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), webBridgePlugin(), stubCodexAppServer()],
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2022',
  },
})

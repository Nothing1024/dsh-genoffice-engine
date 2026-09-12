import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

/**
 * Web build for GenOffice HTML: the renderer plus the web bridge
 * (web-bridge.ts) injected before main.tsx. Preview iframes use blob:
 * URLs, so CSP must allow frame-src blob/data/http(s).
 *
 *   npm run web:build -w @genoffice/html   → apps/html/web-dist/
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
          content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data: http: https:; connect-src 'self' https: wss: ws: http: data:"
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
  base: '/html/',
  plugins: [react(), webBridgePlugin(), stubCodexAppServer()],
  server: {
    port: Number(process.env.HTML_WEB_DEV_PORT) || 5178,
    strictPort: true,
    proxy: {
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

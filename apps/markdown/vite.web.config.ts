import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'

// npm hoists some @tiptap packages to the repo root and nests others under
// this app — dedupe forces every import onto this app's single copy (same
// policy as vite.renderer.config.ts).
const TIPTAP_DEDUPE = [
  '@tiptap/core',
  '@tiptap/pm',
  '@tiptap/react',
  '@tiptap/extensions',
  '@tiptap/extension-list',
  '@tiptap/extension-table',
  '@tiptap/extension-image',
  '@tiptap/suggestion',
  '@tiptap/markdown',
  '@tiptap/extension-highlight',
  '@tiptap/extension-code-block',
]

/**
 * Web build for GenOffice Markdown: the *unmodified* renderer plus the web
 * bridge (web-bridge.ts) injected before main.tsx.
 *
 *   npm run web:build -w @genoffice/markdown   → apps/markdown/web-dist/
 */
function webBridgePlugin(): Plugin {
  return {
    name: 'genoffice-web-bridge',
    // 'pre': must run before vite's own html plugin in build mode
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
  // served under /markdown/ by web/server.mjs — asset URLs must match
  base: '/markdown/',
  plugins: [react(), webBridgePlugin()],
  resolve: { dedupe: TIPTAP_DEDUPE },
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2022',
  },
})

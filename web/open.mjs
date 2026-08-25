#!/usr/bin/env node
/**
 * GenOffice Web — open a LOCAL file from the command line.
 *
 *   node web/open.mjs ~/Documents/报告.docx
 *   node web/open.mjs ./notes.md
 *
 * What it does:
 *   1. makes sure the relay server (web/server.mjs) is running on :8787
 *   2. uploads the file bytes to it (POST /api/inject → one-shot token)
 *   3. opens the matching editor URL in the default browser
 *      (.docx → /docs, .md → /markdown, .xlsx → /sheets, .pptx → /slides, .pdf → /pdf)
 *
 * The browser page pulls the bytes back from the relay and registers the file
 * in its IndexedDB — no filesystem access from the browser is needed, so any
 * local path works regardless of browser security restrictions.
 *
 * Options:
 *   --port N       relay port (default 8787)
 *   --no-browser   only print the URL instead of opening the browser
 *   --print-url    alias of --no-browser (for scripts)
 */
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const BASE = `http://127.0.0.1:${PORT}`

const args = process.argv.slice(2)
const noBrowser = args.includes('--no-browser') || args.includes('--print-url')
const fileArg = args.find((a) => !a.startsWith('--'))
if (!fileArg) {
  console.error('用法: node web/open.mjs <文件路径>   (支持 .docx / .md / .xlsx / .pptx / .pdf)')
  console.error('示例: node web/open.mjs ~/Desktop/报告.docx')
  process.exit(1)
}

const filePath = resolve(fileArg.replace(/^~(?=\/)/, process.env.HOME ?? ''))
const ext = extname(filePath).toLowerCase().replace('.', '')
const APP_BY_EXT = { docx: 'docs', md: 'markdown', markdown: 'markdown', xlsx: 'sheets', pptx: 'slides', pdf: 'pdf' }
const app = APP_BY_EXT[ext]
if (!app) {
  console.error(`暂不支持 .${ext} 文件（当前支持 .docx / .md / .xlsx / .pptx / .pdf）`)
  process.exit(1)
}

async function relayUp() {
  try {
    const resp = await fetch(`${BASE}/api/health`)
    return resp.ok
  } catch {
    return false
  }
}

async function startRelay() {
  console.log('[open.mjs] 启动中继服务 (web/server.mjs)…')
  const child = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], {
    stdio: 'inherit',
    detached: true,
  })
  child.unref()
  // wait for the health endpoint
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await relayUp()) return
  }
  console.error('[open.mjs] 中继服务启动超时，请手动运行: node web/server.mjs')
  process.exit(1)
}

// 1. file checks
let bytes
try {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('not a file')
  if (info.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 限制')
  bytes = await readFile(filePath)
} catch (e) {
  console.error(`无法读取文件: ${filePath} (${e.message})`)
  process.exit(1)
}

// 2. relay
if (!(await relayUp())) await startRelay()

// 3. inject
let token
try {
  const resp = await fetch(`${BASE}/api/inject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(filePath.split('/').pop() ?? 'file'),
    },
    body: bytes,
  })
  const data = await resp.json()
  if (!data.ok || !data.token) throw new Error(data.error ?? 'inject failed')
  token = data.token
} catch (e) {
  console.error(`[open.mjs] 注入失败: ${e.message}`)
  process.exit(1)
}

// 4. open
const url = `${BASE}/${app}/?open=inject:${token}`
if (noBrowser) {
  console.log(url)
} else {
  console.log(`[open.mjs] 打开: ${url}`)
  const opener =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
}

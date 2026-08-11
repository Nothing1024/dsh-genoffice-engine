/**
 * Standalone verification of the host-side pty WebSocket endpoint
 * (Task 18 / EVD-005): loads the BUILT host half (lib/index.js) with a stub
 * cordis context, mounts its upgrade route on a real http server, then:
 *  1. ws connect + `echo hello-from-pty` → output frame contains the echo
 *  2. `exit` → exit frame, ws closes
 *  3. evil Origin → socket destroyed (no handshake)
 *  4. orphan check: after close, no bash child of this process remains
 *
 * Usage: node scripts/host-pty-verify.mjs
 */
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostHalf = await import(join(here, '..', 'lib', 'index.js'))
const outDir = join(here, '..', '..', 'docs', 'dsh-sidebar-ecosystem', 'evidence', 'UF-005')
mkdirSync(outDir, { recursive: true })

const logs = []
const log = (s) => { logs.push(s); console.log(s) }

// ── stub cordis context ─────────────────────────────────────────
let upgradeHandler = null
const ctx = {
  effect: (fn) => fn(),
  logger: { info: (...a) => log('[host] ' + a.join(' ')) },
  httpServer: {
    registerUpgrade: (route) => {
      upgradeHandler = route.handler
      return () => { upgradeHandler = null }
    },
  },
}
hostHalf.apply(ctx)
log('apply ran; PTY_WS_PATH=' + hostHalf.PTY_WS_PATH)

// ── real http server with the plugin's upgrade route ────────────
const server = createServer((_req, res) => { res.writeHead(404); res.end() })
server.on('upgrade', (req, socket, head) => {
  if (upgradeHandler) upgradeHandler(req, socket, head)
  else socket.destroy()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log('test server on 127.0.0.1:' + port)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1+2: echo then exit ─────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty.ws`)
const frames = []
ws.onmessage = (ev) => {
  try { frames.push(JSON.parse(ev.data)) } catch { /* keep raw */ }
}
await new Promise((resolve, reject) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'input', data: 'echo hello-from-pty\n' }))
    setTimeout(() => { ws.send(JSON.stringify({ type: 'input', data: 'exit\n' })) }, 1200)
  }
  ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || '')))
  ws.onclose = () => resolve()
  setTimeout(() => reject(new Error('timeout')), 15000)
})
const output = frames.filter((f) => f.type === 'output').map((f) => f.data).join('')
const exitFrame = frames.find((f) => f.type === 'exit')
const echoOk = output.includes('hello-from-pty')
log('echo received: ' + echoOk)
log('exit frame: ' + JSON.stringify(exitFrame))

// ── 3: evil origin rejected ─────────────────────────────────────
const evil = await new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/pty.ws`, { headers: { Origin: 'https://evil.example' } })
  sock.onopen = () => resolve('OPENED')
  sock.onerror = () => resolve('REJECTED')
  sock.onclose = () => resolve('CLOSED')
  setTimeout(() => resolve('TIMEOUT'), 4000)
})
log('evil origin: ' + evil)

// ── 4: orphan check ─────────────────────────────────────────────
await sleep(800)
const kids = execSync(`pgrep -P ${process.pid} || true`).toString().trim()
log('remaining children of the test process: ' + JSON.stringify(kids.split('\n').filter(Boolean)))

const verdict = { echoOk, exitFrame, evilOriginRejected: evil !== 'OPENED', orphans: kids.trim() === '' }
log('VERDICT ' + JSON.stringify(verdict, null, 2))
writeFileSync(join(outDir, 'ws-echo.log'), logs.join('\n') + '\n')
writeFileSync(join(outDir, 'no-orphan.txt'), `children after close: ${JSON.stringify(kids.split('\n').filter(Boolean))}\nverdict: ${JSON.stringify(verdict)}\n`)

server.close()
process.exit(echoOk && verdict.evilOriginRejected && verdict.orphans ? 0 : 1)

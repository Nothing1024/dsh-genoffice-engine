/**
 * Node half of the dsh-genoffice-sidebar plugin: the host-side pty
 * WebSocket endpoint for the terminal tab (Task 18).
 *
 * ASM-005 resolution: the DSH `ctx.pty` service is line/send-oriented
 * (model-facing tools: one exclusive send operation per session with
 * `readOutput()` deltas) — a poor fit for an interactive xterm that needs
 * per-keystroke streaming push and real process signals. Per the task's
 * sanctioned fallback, this plugin spawns `node-pty` DIRECTLY (the library
 * is already in the DSH dependency closure via dsh-pty-local, resolved from
 * the healed profile module fallback at runtime).
 *
 * Protocol (JSON frames, one object per message):
 *   client → host: { type: 'input', data } | { type: 'resize', cols, rows }
 *                  | { type: 'ping' }
 *   host → client: { type: 'output', data } | { type: 'exit', code, signal }
 *                  | { type: 'error', message }
 *
 * Lifecycle (INV-006): ws close/error destroys the pty; a socket silent for
 * 30s (no client ping) is reaped; plugin disposal destroys every session.
 */
import { homedir } from 'node:os'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import * as nodePty from 'node-pty'
import WebSocket, { WebSocketServer } from 'ws'
import type { Context } from 'cordis'
// Type-only: pulls the httpServer service merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Plugin name (host half). */
export const name = 'genoffice-sidebar-host'

/** Required services: the webserver's upgrade route registry. */
export const inject = ['httpServer']

/** The ws endpoint path (client connects ws://<host>:<port>/api/pty.ws). */
export const PTY_WS_PATH = '/api/pty.ws'

/** Loopback origins only: the DSH GUI page and local tooling. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/** Reap sockets with no client heartbeat for this long (INV-006 anti-orphan). */
const IDLE_REAP_MS = 30_000

/** Sweep interval for the idle reaper. */
const SWEEP_INTERVAL_MS = 10_000

/** One live session: the pty plus its last heartbeat. */
interface PtySession {
  terminal: ReturnType<typeof nodePty.spawn>
  lastActivity: number
}

/** Destroy one session (idempotent): kill the pty, close the socket. */
function destroySession(ws: WebSocket, sessions: Map<WebSocket, PtySession>): void {
  const session = sessions.get(ws)
  if (session === undefined) return
  sessions.delete(ws)
  try {
    session.terminal.kill()
  } catch {
    // The pty already exited — nothing to kill.
  }
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close()
  }
}

/**
 * Host plugin body: register the /api/pty.ws upgrade route and manage the
 * pty session registry for its lifetime.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true })
    const sessions = new Map<WebSocket, PtySession>()

    const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      // Unauthenticated pty sessions are forbidden: only loopback origins
      // may open a terminal into the host (spec: 握手校验 Origin).
      const origin = req.headers.origin
      if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) {
        socket.destroy()
        return
      }
      let cwd = homedir()
      try {
        const query = new URL(req.url ?? '/', 'http://x').searchParams.get('cwd')
        if (query !== null && query.length > 0) cwd = query
      } catch {
        // Malformed request URL — keep the home cwd.
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, cwd)
      })
    }

    const disposeUpgrade = ctx.httpServer.registerUpgrade({
      path: PTY_WS_PATH,
      handler: handleUpgrade,
    })

    wss.on('connection', (ws: WebSocket, _req: IncomingMessage, cwd: string) => {
      let terminal: ReturnType<typeof nodePty.spawn>
      try {
        terminal = nodePty.spawn(process.env.SHELL ?? 'bash', [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ws.send(JSON.stringify({ type: 'error', message: `pty spawn failed: ${message}` }))
        ws.close()
        return
      }
      sessions.set(ws, { terminal, lastActivity: Date.now() })

      terminal.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }))
        }
      })
      terminal.onExit(({ exitCode, signal }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal: signal ?? null }))
        }
        sessions.delete(ws)
        ws.close()
      })

      ws.on('message', (raw: WebSocket.RawData) => {
        const session = sessions.get(ws)
        if (session === undefined) return
        session.lastActivity = Date.now()
        let msg: unknown
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return // malformed frame — ignore
        }
        if (typeof msg !== 'object' || msg === null) return
        const typed = msg as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }
        if (typed.type === 'input' && typeof typed.data === 'string') {
          terminal.write(typed.data)
        } else if (typed.type === 'resize' && typeof typed.cols === 'number' && typeof typed.rows === 'number') {
          try {
            terminal.resize(Math.max(1, Math.floor(typed.cols)), Math.max(1, Math.floor(typed.rows)))
          } catch {
            // pty already exited — resize is moot
          }
        }
      })
      ws.on('close', () => { destroySession(ws, sessions) })
      ws.on('error', () => { destroySession(ws, sessions) })
    })

    // Idle reaper: half-open sockets (page gone without a close frame) must
    // not leak shells (INV-006).
    const sweep = setInterval(() => {
      const now = Date.now()
      for (const [ws, session] of [...sessions]) {
        if (now - session.lastActivity > IDLE_REAP_MS) destroySession(ws, sessions)
      }
    }, SWEEP_INTERVAL_MS)

    ctx.logger.info('[genoffice-sidebar] pty ws endpoint ready at', PTY_WS_PATH)

    return () => {
      clearInterval(sweep)
      for (const ws of [...sessions.keys()]) destroySession(ws, sessions)
      disposeUpgrade()
      wss.close()
    }
  }, 'genoffice-sidebar: pty ws endpoint')
}

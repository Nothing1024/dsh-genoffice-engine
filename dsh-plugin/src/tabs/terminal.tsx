/**
 * Terminal tab panel: xterm.js over the host pty WebSocket (BR-010, UF-005).
 *
 * - Mount: creates an xterm instance (fit addon) once; a separate connection
 *   effect owns the ws lifecycle so the terminal text survives reconnects.
 *   `term.onData` forwards every keystroke as an input frame (Ctrl+C reaches
 *   the pty as \x03 and interrupts foreground commands).
 * - State machine: disconnected → connecting → connected → closed; a failed
 *   connect shows 连接失败 + 重连 with exponential backoff (1s/2s/5s).
 * - Lifecycle: unmount closes the ws (the host destroys the pty — INV-006);
 *   re-activating the tab creates a fresh session (BR-010 allows rebuilds).
 *   A 15s ping keeps the host-side idle reaper from killing an idle session.
 * - Fit: a ResizeObserver refits the terminal when the panel resizes.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import xtermCss from 'xterm/css/xterm.css?raw'
import css from './terminal.module.css'

/** Connection states (UF-005). */
type ConnState = 'disconnected' | 'connecting' | 'connected' | 'closed'

/** Reconnect backoff steps (seconds). */
const BACKOFF = [1, 2, 5]

/** Client heartbeat interval (host reaps sockets idle > 30s). */
const PING_INTERVAL_MS = 15_000

/** Inject the xterm stylesheet once per page (the bundle carries it as raw text). */
function ensureXtermCss(): void {
  if (document.querySelector('style[data-plugin-css="genoffice-xterm"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'genoffice-xterm'
  tag.textContent = xtermCss
  document.head.appendChild(tag)
}

/**
 * Render the terminal panel.
 * @returns the panel element tree.
 */
export function TerminalPanel(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [exitInfo, setExitInfo] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [retryNonce, setRetryNonce] = useState(0)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Mount-once: xterm instance + fit + resize observation.
  useEffect(() => {
    ensureXtermCss()
    const container = containerRef.current
    if (container === null) return

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: {
        background: 'transparent',
        foreground: '#e8e8e8',
        cursor: '#e8e8e8',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try { fit.fit() } catch { /* container not laid out yet */ }
    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => {
      try { fit.fit() } catch { /* container hidden */ }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
  }, [])

  // Connection effect: one attempt per retryNonce, backoff via setTimeout.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    setState('connecting')
    setExitInfo(null)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/pty.ws`)
    wsRef.current = ws

    let pingTimer: number | undefined
    let settled = false

    ws.onopen = () => {
      setState('connected')
      setAttempt(0)
      try { fitRef.current?.fit() } catch { /* ignore */ }
      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, PING_INTERVAL_MS)
    }
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: unknown; code?: unknown; message?: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data)
      } else if (msg.type === 'exit') {
        settled = true
        setExitInfo(`进程已退出 (code ${String(msg.code)})`)
        setState('closed')
        ws.close()
      } else if (msg.type === 'error' && typeof msg.message === 'string') {
        settled = true
        setExitInfo(String(msg.message))
        setState('closed')
        ws.close()
      }
    }
    ws.onclose = () => {
      if (pingTimer !== undefined) window.clearInterval(pingTimer)
      if (settled) return // clean exit/error frame — no reconnect
      setState('disconnected')
      const backoff = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] ?? 5
      const timer = window.setTimeout(() => {
        setAttempt((n) => n + 1)
        setRetryNonce((n) => n + 1)
      }, backoff * 1000)
      return () => { window.clearTimeout(timer) }
    }
    ws.onerror = () => {
      // onclose follows; the backoff path owns the reconnect.
    }

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    return () => {
      onData.dispose()
      if (pingTimer !== undefined) window.clearInterval(pingTimer)
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attempt drives the backoff label only
  }, [retryNonce])

  return (
    <div className={css.panel}>
      {state === 'connecting' && <div className={css.hint}>正在连接终端…</div>}
      {state === 'disconnected' && (
        <div className={css.hint}>
          连接失败 — 自动重连中（第 {attempt + 1} 次）…
        </div>
      )}
      {state === 'closed' && (
        <div className={css.hint}>
          {exitInfo ?? '会话已结束'}
          <button
            type="button"
            className={css.btn}
            onClick={() => { setExitInfo(null); setRetryNonce((n) => n + 1) }}
          >新建会话</button>
        </div>
      )}
      <div ref={containerRef} className={css.term} />
    </div>
  )
}

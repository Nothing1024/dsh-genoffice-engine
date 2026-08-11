/**
 * GenOffice tab panel: relay-backed file browser + embedded read-only preview.
 *
 * - List: GET /api/dir?path= (default = home), path bar with 主目录/上级,
 *   directory rows navigate, docx/md rows open the preview, every other type
 *   is disabled with a "仅桌面版可用" hint (BR-004/BR-005/BR-007, UF-002).
 * - Preview: iframe on the genoffice relay (`/docs/?open=path:` for docx,
 *   `/markdown/?open=path:` for md), loading state on load, 10s timeout →
 *   error + retry; the iframe is keyed per selection so stale documents
 *   never linger (BR-011, UF-002).
 * - 在浏览器中打开: window.open of the same URL in a new tab; a null return
 *   (popup blocked) shows an inline hint (BR-008, UF-003).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './genoffice.module.css'

/** The genoffice relay base (loopback; CORS loopback whitelist covers it). */
const RELAY_BASE = 'http://localhost:8787'

/** Previewable extensions → relay app path (BR-007: only docx/md previewable). */
const PREVIEWABLE: Record<string, string> = { docx: 'docs', md: 'markdown' }

/** One /api/dir entry. */
interface DirEntry {
  name: string
  dir: boolean
  hidden: boolean
  symlink: boolean
  size: number | null
  mtimeMs: number | null
  ext?: string
}

/** /api/dir response. */
interface DirResponse {
  ok: boolean
  path?: string
  parent?: string
  entries?: DirEntry[]
  error?: string
}

/** Panel view: the list, or a preview of one selected file. */
type View =
  | { kind: 'list' }
  | { kind: 'preview'; path: string; name: string; url: string }

/** Join two path segments without node:path (browser-side). */
function joinPath(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b
}

/** Build the preview URL for an absolute path (BR-007). */
function previewUrlFor(path: string, ext: string): string {
  const app = PREVIEWABLE[ext]
  if (app === undefined) return ''
  return `${RELAY_BASE}/${app}/?open=${encodeURIComponent(`path:${path}`)}`
}

/**
 * Render the GenOffice panel.
 * @returns the panel element tree.
 */
export function GenOfficePanel(): ReactNode {
  const [view, setView] = useState<View>({ kind: 'list' })
  // List state (UF-002 state machine: idle → loading → list | error).
  const [path, setPath] = useState<string>('')
  const [parent, setParent] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [relayDown, setRelayDown] = useState(false)
  // Preview state (UF-002: preview-loading → preview | error).
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [popupHint, setPopupHint] = useState(false)
  const loadSeq = useRef(0)

  const loadList = async (nextPath?: string): Promise<void> => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    setRelayDown(false)
    try {
      const resp = await fetch(`${RELAY_BASE}/api/dir?path=${encodeURIComponent(nextPath ?? '')}`)
      const data = (await resp.json()) as DirResponse
      if (seq !== loadSeq.current) return
      if (!data.ok) {
        setError(data.error ?? '路径不可读')
      } else {
        setPath(data.path ?? '')
        setParent(data.parent)
        // Hidden files are sorted last by the relay; hide them here (UF-002).
        setEntries((data.entries ?? []).filter((e) => !e.hidden))
      }
    } catch {
      if (seq !== loadSeq.current) return
      setRelayDown(true)
      setError('中继服务未启动')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  // Initial load: the user's home directory.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, [])

  const pickFile = (entry: DirEntry): void => {
    // Symlink entries are navigable: the relay resolves the path on the next
    // readdir (an explicit loopback user action); the listing itself never
    // chases links (BR-005 policy stays at the relay).
    if (entry.dir || entry.symlink) {
      void loadList(joinPath(path, entry.name))
      return
    }
    const ext = entry.ext ?? ''
    const app = PREVIEWABLE[ext]
    if (app === undefined) return // unsupported types are disabled in the UI
    const abs = joinPath(path, entry.name)
    setView({ kind: 'preview', path: abs, name: entry.name, url: previewUrlFor(abs, ext) })
    setPreviewLoaded(false)
    setPreviewError(false)
    setRetryKey((k) => k + 1)
    setPopupHint(false)
  }

  const openInBrowser = (): void => {
    if (view.kind !== 'preview') return
    const win = window.open(view.url, '_blank', 'noopener')
    if (win === null) setPopupHint(true) // popup blocked (UF-003 failure branch)
  }

  if (view.kind === 'preview') {
    return (
      <div className={css.panel}>
        <div className={css.toolbar}>
          <button type="button" className={css.btn} onClick={() => { setView({ kind: 'list' }) }}>← 返回</button>
          <span className={css.fileName} title={view.path}>{view.name}</span>
          <button type="button" className={css.btn} style={{ marginLeft: 'auto' }} onClick={openInBrowser}>在浏览器中打开</button>
        </div>
        {popupHint && <div className={css.hint}>弹窗被拦截 — 请允许弹窗后重试</div>}
        {previewError
          ? (
            <div className={css.hint}>
              预览加载失败
              <button
                type="button"
                className={css.btn}
                onClick={() => {
                  setPreviewError(false)
                  setPreviewLoaded(false)
                  setRetryKey((k) => k + 1)
                }}
              >重试</button>
            </div>
          )
          : (
            <iframe
              key={`${view.url}:${retryKey}`}
              src={view.url}
              className={css.iframe}
              // allow-same-origin: the docs app fetches relay resources
              // same-origin; allow-downloads: Ctrl+S inside the preview must
              // download a new copy, never write back (BR-011).
              sandbox="allow-scripts allow-same-origin allow-downloads"
              onLoad={() => { setPreviewLoaded(true) }}
            />
          )}
        {!previewLoaded && !previewError && <div className={css.hint}>预览加载中…</div>}
        <PreviewTimeout loaded={previewLoaded} onTimeout={() => { setPreviewError(true) }} />
      </div>
    )
  }

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <button type="button" className={css.btn} onClick={() => { void loadList() }}>⌂ 主目录</button>
        <button type="button" className={css.btn} disabled={parent === undefined} onClick={() => { if (parent !== undefined) void loadList(parent) }}>.. 上级</button>
        <button type="button" className={css.btn} onClick={() => { void loadList(path) }}>刷新</button>
        <span className={css.pathText} title={path}>{path || '…'}</span>
      </div>
      {loading && <div className={css.hint}>加载中…</div>}
      {!loading && error !== null && (
        <div className={css.hint}>
          {error}
          {relayDown && <span>— 请启动 relay（npm run web）后</span>}
          <button type="button" className={css.btn} onClick={() => { void loadList(path) }}>重试</button>
        </div>
      )}
      {!loading && error === null && entries !== null && entries.length === 0 && (
        <div className={css.hint}>空目录</div>
      )}
      {!loading && error === null && entries !== null && (
        <div className={css.list}>
          {entries.map((entry) => {
            const previewable = !entry.dir && !entry.symlink && PREVIEWABLE[entry.ext ?? ''] !== undefined
            const clickable = entry.dir || entry.symlink || previewable
            return (
              <div
                key={entry.name}
                className={`${css.row} ${clickable ? css.rowClickable : css.rowDisabled}`}
                title={entry.dir ? '进入目录' : entry.symlink ? '符号链接（可能指向目录）' : previewable ? '点击预览' : '仅桌面版可用'}
                onClick={() => { pickFile(entry) }}
              >
                <span className={css.rowIcon}>{entry.dir ? '📁' : entry.symlink ? '🔗' : '📄'}</span>
                <span className={css.rowName}>{entry.name}</span>
                {!entry.dir && !previewable && !entry.symlink && <span className={css.rowTag}>仅桌面版可用</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 10s preview timeout: when the iframe neither loads nor errors within the
 * window, the panel shows the error + retry branch (UF-002).
 */
function PreviewTimeout({ loaded, onTimeout }: { loaded: boolean; onTimeout: () => void }): ReactNode {
  useEffect(() => {
    if (loaded) return
    const timer = window.setTimeout(onTimeout, 10_000)
    return () => { window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm once per preview
  }, [loaded])
  return null
}

/**
 * Files tab panel: host-backed directory browser via `ctx.workspaces.
 * listDirectory` (the runtime's wrapper over the host.listDirectory RPC —
 * browser ↔ DSH host, no CORS; BR-009, UF-004).
 *
 * State machine (UF-004): idle → loading → list | error (an error keeps the
 * last list). Path navigation: 主目录 / 上级 (from the response's crumbs
 * ancestry) / directory rows; a rejected call (host disconnected) shows the
 * disconnect hint.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import css from './files.module.css'

/** The injected data access (bound in the plugin apply closure). */
export interface FilesPanelInjected {
  /** List one directory level; absent path = the host account home. */
  listDirectory: (path?: string) => Promise<DirectoryListing>
}

/**
 * Render the files panel.
 * @param props - the injected data access.
 * @returns the panel element tree.
 */
export function FilesPanel({ listDirectory }: FilesPanelInjected): ReactNode {
  const [path, setPath] = useState<string>('')
  const [home, setHome] = useState<string>('')
  const [parent, setParent] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSeq = useRef(0)

  const load = async (nextPath?: string): Promise<void> => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const value = await listDirectory(nextPath)
      if (seq !== loadSeq.current) return
      setPath(value.path)
      setHome(value.home)
      // crumbs = the full ancestry INCLUDING the listed level; the parent is
      // the second-to-last crumb.
      setParent(value.crumbs.length > 1 ? value.crumbs[value.crumbs.length - 2]?.path : undefined)
      setEntries(value.entries.filter((e) => !e.hidden))
    } catch (reason) {
      if (seq !== loadSeq.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  // Initial load: home.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, [])

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <button type="button" className={css.btn} onClick={() => { void load() }}>⌂ 主目录</button>
        <button type="button" className={css.btn} disabled={parent === undefined} onClick={() => { if (parent !== undefined) void load(parent) }}>.. 上级</button>
        <button type="button" className={css.btn} onClick={() => { void load(path) }}>刷新</button>
        <span className={css.pathText} title={path}>{path || home || '…'}</span>
      </div>
      {loading && <div className={css.hint}>加载中…</div>}
      {!loading && error !== null && (
        <div className={css.hint}>
          {error}
          <button type="button" className={css.btn} onClick={() => { void load(path) }}>重试</button>
        </div>
      )}
      {!loading && error === null && entries !== null && entries.length === 0 && (
        <div className={css.hint}>空目录</div>
      )}
      {!loading && entries !== null && entries.length > 0 && (
        <div className={css.list}>
          {entries.map((entry) => (
            <div
              key={entry.path}
              className={`${css.row} ${css.rowClickable}`}
              title={entry.name}
              onClick={() => { void load(entry.path) }}
            >
              <span className={css.rowIcon}>📁</span>
              <span className={css.rowName}>{entry.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

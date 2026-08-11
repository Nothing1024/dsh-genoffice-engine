/**
 * TabsDock — the right-hand floating dock (终端 | GenOffice | 文件).
 *
 * Mounted by the client plugin directly (React createRoot over a fixed
 * container), because the layout-owned `details` column is already claimed
 * by the official conversation-details panel and single slots cannot be
 * shared. The dock floats over the conversation column's right edge, with a
 * collapse toggle; the active tab survives collapse within the session via
 * a transient store (BR-003, same policy as the official layout store).
 */
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-connection/client'
import { FilesPanel } from './tabs/files.tsx'
import { GenOfficePanel } from './tabs/genoffice.tsx'
import { TerminalPanel } from './tabs/terminal.tsx'
import css from './TabsDock.module.css'

/** The three dock tabs. */
export type TabId = 'terminal' | 'genoffice' | 'files'

interface TabDef {
  id: TabId
  label: string
  icon: ReactNode
}

const ICON_PROPS = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

/** Terminal icon: prompt chevron. */
function TerminalIcon(): ReactNode {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M5.5 6l2 2-2 2M9 10h2" />
    </svg>
  )
}

/** GenOffice icon: document. */
function GenOfficeIcon(): ReactNode {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3M6.5 8.5h3M6.5 11h3" />
    </svg>
  )
}

/** Files icon: folder. */
function FilesIcon(): ReactNode {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 4.5h4l1.5 2H14v6.5H2z" />
    </svg>
  )
}

/** All three tabs in display order. */
const TABS: readonly TabDef[] = [
  { id: 'terminal', label: '终端', icon: <TerminalIcon /> },
  { id: 'genoffice', label: 'GenOffice', icon: <GenOfficeIcon /> },
  { id: 'files', label: '文件', icon: <FilesIcon /> },
]

/** Session-local dock state (refresh returns to defaults). */
interface DockState {
  active: TabId
  collapsed: boolean
}

export interface TabsDockProps {
  /** Directory listing for the files tab (the runtime's workspaces RPC). */
  listDirectory: (path?: string) => Promise<DirectoryListing>
}

/**
 * Render the right-hand floating dock.
 * @param props - the injected directory-listing service.
 * @returns the dock element tree.
 */
export function TabsDock({ listDirectory }: TabsDockProps): ReactNode {
  const [state, setState] = useState<DockState>({ active: 'terminal', collapsed: false })
  const stateRef = useRef(state)
  stateRef.current = state

  // Keep the dock's persisted width (if any) off the DOM while collapsed.
  if (state.collapsed) {
    return (
      <div className={css.dockCollapsed}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={css.railBtn}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => setState({ ...stateRef.current, active: tab.id, collapsed: false })}
          >
            {tab.icon}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className={css.dock}>
      <div className={css.tabBar} role="tablist" aria-label="右侧面板">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={state.active === tab.id}
            className={state.active === tab.id ? css.tabActive : css.tab}
            onClick={() => setState((s) => ({ ...s, active: tab.id }))}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={css.collapseBtn}
          aria-label="折叠右侧面板"
          title="折叠右侧面板"
          onClick={() => setState((s) => ({ ...s, collapsed: true }))}
        >
          <svg {...ICON_PROPS}>
            <path d="M9 4l4 4-4 4M5 4l4 4-4 4" />
          </svg>
        </button>
      </div>
      <div className={css.body}>
        {state.active === 'terminal'
          ? <TerminalPanel />
          : state.active === 'genoffice'
            ? <GenOfficePanel />
            : <FilesPanel listDirectory={listDirectory} />}
      </div>
    </div>
  )
}

/** Convenience: create the mount element for the client plugin. */
export function createDockElement(): HTMLElement {
  const el = document.createElement('div')
  el.className = css.mount ?? ''
  return el
}

/**
 * Mount the dock into a host element (called by the client plugin).
 * Returns a disposer that unmounts and removes the host.
 */
export function mountDock(
  host: HTMLElement,
  listDirectory: (path?: string) => Promise<DirectoryListing>,
): () => void {
  const root = createRoot(host)
  root.render(<TabsDock listDirectory={listDirectory} />)
  return () => {
    root.unmount()
  }
}

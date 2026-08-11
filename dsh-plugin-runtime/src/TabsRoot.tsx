/**
 * TabsRoot — the unified sidebar container. Replaces the official ui-sidebar
 * shell (patched out of the profile): a tab bar (工作区 | 终端 | GenOffice |
 * 文件) over the ecosystem slots, the official workspace browser rendered on
 * the workspace tab, and the official settings seat kept at the foot. The
 * collapsed state renders a rail of tab icons (clicking expands into that
 * tab); the active tab survives collapse/expand via the transient store
 * (BR-003). Tabs whose slot has no registrant are hidden (UF-001 failure
 * branch), and a throwing panel degrades to an error placeholder instead of
 * blanking the column.
 */
import type { ReactNode } from 'react'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabsRootComponentProps } from './contract.ts'
import type { TabId } from './store.ts'
import css from './TabsRoot.module.css'

/** One tab definition: label, icon, and the slot it renders when active. */
interface TabDef {
  id: TabId
  label: string
  icon: ReactNode
  /** Tab slot; undefined = the workspace tab (renders the official browser). */
  slot?: 'sidebar.tabs.terminal' | 'sidebar.tabs.genoffice' | 'sidebar.tabs.files'
}

const ICON_PROPS = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

/** Workspace icon: layered panes. */
function WorkspaceIcon(): ReactNode {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="3" width="12" height="9" rx="1.5" />
      <path d="M4 6.5h8M4 9h5" />
    </svg>
  )
}

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

/** All four tabs in display order. */
const TABS: readonly TabDef[] = [
  { id: 'workspace', label: '工作区', icon: <WorkspaceIcon /> },
  { id: 'terminal', label: '终端', icon: <TerminalIcon />, slot: 'sidebar.tabs.terminal' },
  { id: 'genoffice', label: 'GenOffice', icon: <GenOfficeIcon />, slot: 'sidebar.tabs.genoffice' },
  { id: 'files', label: '文件', icon: <FilesIcon />, slot: 'sidebar.tabs.files' },
]

/**
 * Render the unified sidebar column.
 * @param props - composed slot props (contract.ts).
 * @returns the sidebar element tree.
 */
export function TabsRoot({
  collapsed,
  useStore,
  actions,
  renderSlot,
  toggleSidebar,
  isTabRegistered,
}: TabsRootComponentProps) {
  const activeTab = useStore((s) => s.active)

  const visible = TABS.filter((tab) => tab.slot === undefined || isTabRegistered(tab.slot))

  if (collapsed) {
    return (
      <div className={css.rootCollapsed}>
        <div className={css.rail}>
          {visible.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? css.railActive : css.railBtn}
              aria-label={tab.label}
              title={tab.label}
              onClick={() => { actions.setActive(tab.id); toggleSidebar() }}
            >
              {tab.icon}
            </button>
          ))}
        </div>
        <div className={css.railSpacer} />
        <div className={css.footRail}>{renderSlot('sidebar.settings', { wide: false })}</div>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.tabBar} role="tablist" aria-label="侧边栏面板">
        {visible.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? css.tabActive : css.tab}
            onClick={() => { actions.setActive(tab.id) }}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={css.collapseBtn}
          aria-label="折叠侧边栏"
          title="折叠侧边栏"
          onClick={() => { toggleSidebar() }}
        >
          <IconPanelLeftOutline16 size={14} />
        </button>
      </div>
      <div className={css.body}>
        {/* Per-entry crash containment is the framework's own SlotErrorBoundary
            (web-react): a throwing panel logs 'slot entry crashed' and renders
            an empty pane — the sidebar and sibling tabs stay alive (UF-001). */}
        {activeTab === 'workspace'
          ? renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => { if (collapsed) toggleSidebar() } })
          : activeTab === 'terminal'
            ? renderSlot('sidebar.tabs.terminal', {})
            : activeTab === 'genoffice'
              ? renderSlot('sidebar.tabs.genoffice', {})
              : renderSlot('sidebar.tabs.files', {})}
      </div>
      <div className={css.foot}>{renderSlot('sidebar.settings', { wide: true })}</div>
    </div>
  )
}

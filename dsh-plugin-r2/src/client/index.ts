/**
 * Client half of the dsh-genoffice-sidebar plugin: registers the unified
 * sidebar container (TabsRoot) into the layout-owned 'sidebar' slot —
 * replacing the official ui-sidebar shell, which the profile patch disables —
 * and registers the three ecosystem tab panels into the slots TabsRoot
 * declares. The official holes (sidebar.workspaces / sidebar.settings) are
 * re-declared here so ui-workspace / ui-settings keep mounting inside the
 * container (BR-001, INV-001).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into this
// compilation unit so slot keys type-check.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '../slots.ts'
import type { TabSlotKey, TabsRootInjected } from '../contract.ts'
import { TabsRoot } from '../TabsRoot.tsx'
import { createTabsStore } from '../store.ts'
import { FilesPanel, type FilesPanelInjected } from '../tabs/files.tsx'
import { GenOfficePanel } from '../tabs/genoffice.tsx'
import { TerminalPanel } from '../tabs/terminal.tsx'

/** Services required by the tabs container and its panels. */
export const inject = ['slots', 'layout', 'workspaces']

/**
 * Register the tabs container and the three ecosystem tab panels.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injectProps = (): TabsRootInjected => ({
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    isTabRegistered: (slot: TabSlotKey) => ctx.slots.entries(slot).length > 0,
  })

  ctx.effect(() => ctx.slots.register({
    name: 'sidebar',
    // The shell owns geometry; ui-workspace registers the browsing region,
    // ui-settings the foot seat, and the ecosystem tabs the three panels.
    children: {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.tabs.terminal': { kind: 'single', scope: 'root' },
      'sidebar.tabs.genoffice': { kind: 'single', scope: 'root' },
      'sidebar.tabs.files': { kind: 'single', scope: 'root' },
    },
    store: createTabsStore,
    inject: injectProps,
  }, TabsRoot), 'genoffice-sidebar: tabs root registration')

  // Panels register through slots.inject: they wait on TabsRoot's
  // declaration (fiber inject waiting), so boot order is irrelevant and a
  // future redeclaration re-runs them.
  ctx.effect(
    () => ctx.slots.inject('sidebar.tabs.terminal', () => ctx.slots.register({ name: 'sidebar.tabs.terminal' }, TerminalPanel)),
    'genoffice-sidebar: terminal tab',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.tabs.genoffice', () => ctx.slots.register({ name: 'sidebar.tabs.genoffice' }, GenOfficePanel)),
    'genoffice-sidebar: genoffice tab',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.tabs.files', () => {
      const injected = (): FilesPanelInjected => ({
        // The runtime's workspaces service unwraps the RPC and surfaces the
        // host's business error as DirectoryBrowseError.
        listDirectory: (path?: string) => ctx.workspaces.listDirectory(path),
      })
      return ctx.slots.register({ name: 'sidebar.tabs.files', inject: injected }, FilesPanel)
    }),
    'genoffice-sidebar: files tab',
  )
}

/**
 * TabsRoot slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot. This plugin replaces the official ui-sidebar
 * shell (patched out); the two official holes (workspaces / settings) plus
 * the three ecosystem tab slots are declared here — declaring is claiming.
 */
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { createTabsStore } from './store.ts';
/**
 * Registrant-private injected share (arrives via the register inject
 * factory): the container's own controls and the tab-registry probe.
 */
export type TabsRootInjected = {
    /** Toggle the sidebar column through the layout service. */
    toggleSidebar: () => void;
    /**
     * Whether a tab slot currently has a registrant. Unregistered tabs are
     * hidden instead of rendering a blank pane (UF-001 failure branch).
     */
    isTabRegistered: (slot: TabSlotKey) => boolean;
};
/** The three ecosystem tab slots (the workspace tab renders the official browser directly). */
export type TabSlotKey = 'sidebar.tabs.terminal' | 'sidebar.tabs.genoffice' | 'sidebar.tabs.files';
/**
 * Full component props: layout owner state plus the declared holes' render
 * shares, the tabs store seat, and the injected callbacks.
 */
export type TabsRootComponentProps = PropsRuntime<'sidebar'> & PropsRenderSlots<'sidebar.workspaces' | 'sidebar.settings' | 'sidebar.tabs.terminal' | 'sidebar.tabs.genoffice' | 'sidebar.tabs.files'> & PropsStore<ReturnType<typeof createTabsStore>> & TabsRootInjected;
//# sourceMappingURL=contract.d.ts.map
/**
 * TabsDock slot contract: the registrant-side props composition for the
 * layout-owned `details` slot (the right-hand column). The official
 * ui-sidebar stays on the left; this dock owns the terminal / GenOffice /
 * files tabs, each backed by a details.tabs.* child slot.
 */
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { createTabsStore } from './store.ts';
/**
 * Registrant-private injected share (arrives via the register inject
 * factory): the dock's tab-registry probe.
 */
export type TabsDockInjected = {
    /**
     * Whether a tab slot currently has a registrant. Unregistered tabs are
     * hidden instead of rendering a blank pane (UF-001 failure branch).
     */
    isTabRegistered: (slot: TabSlotKey) => boolean;
};
/** The three ecosystem tab slots in the right-hand dock. */
export type TabSlotKey = 'details.tabs.terminal' | 'details.tabs.genoffice' | 'details.tabs.files';
/**
 * Full component props: the details owner share (empty), the declared
 * child-slot render shares, the tabs store seat, and the injected callbacks.
 */
export type TabsDockComponentProps = PropsRuntime<'details'> & PropsRenderSlots<'details.tabs.terminal' | 'details.tabs.genoffice' | 'details.tabs.files'> & PropsStore<ReturnType<typeof createTabsStore>> & TabsDockInjected;
//# sourceMappingURL=contract.d.ts.map
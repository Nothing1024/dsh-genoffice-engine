/**
 * Transient tabs store: the active right-dock tab, kept across column
 * close/reopen within the session (BR-003). Like the official layout store,
 * state is in-memory only — a refresh returns to the default tab. Module
 * level exports the factory only (a module-level handle would pin identity
 * in the module cache across plugin reloads).
 */
import { type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client';
/** The three right-dock ecosystem tabs. */
export type TabId = 'terminal' | 'genoffice' | 'files';
/** Tabs store state: which tab the dock renders. */
export type TabsState = {
    active: TabId;
};
/** Write set of the tabs store (complete mutation surface). */
export type TabsActions = {
    setActive: (draft: TabsState, id: TabId) => void;
};
/**
 * Create the tabs store handle: active tab defaults to the terminal tab.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export declare function createTabsStore(): EngineStoreHandle<TabsState, TabsActions>;
//# sourceMappingURL=store.d.ts.map
import type { ReactNode } from 'react';
import type { DirectoryListing } from '@deepseek-ai/dsh-client-connection/client';
/** The three dock tabs. */
export type TabId = 'terminal' | 'genoffice' | 'files';
export interface TabsDockProps {
    /** Directory listing for the files tab (the runtime's workspaces RPC). */
    listDirectory: (path?: string) => Promise<DirectoryListing>;
}
/**
 * Render the right-hand floating dock.
 * @param props - the injected directory-listing service.
 * @returns the dock element tree.
 */
export declare function TabsDock({ listDirectory }: TabsDockProps): ReactNode;
/** Convenience: create the mount element for the client plugin. */
export declare function createDockElement(): HTMLElement;
/**
 * Mount the dock into a host element (called by the client plugin).
 * Returns a disposer that unmounts and removes the host.
 */
export declare function mountDock(host: HTMLElement, listDirectory: (path?: string) => Promise<DirectoryListing>): () => void;
//# sourceMappingURL=TabsDock.d.ts.map
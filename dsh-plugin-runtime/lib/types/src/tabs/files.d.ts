import type { ReactNode } from 'react';
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client';
/** The injected data access (bound in the plugin apply closure). */
export interface FilesPanelInjected {
    /** List one directory level; absent path = the host account home. */
    listDirectory: (path?: string) => Promise<DirectoryListing>;
}
/**
 * Render the files panel.
 * @param props - the injected data access.
 * @returns the panel element tree.
 */
export declare function FilesPanel({ listDirectory }: FilesPanelInjected): ReactNode;
//# sourceMappingURL=files.d.ts.map
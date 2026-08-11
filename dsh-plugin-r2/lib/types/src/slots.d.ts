/**
 * Slot contract for the sidebar tab ecosystem, merged into the SlotMap the
 * same way ui-layout declares 'sidebar' / ui-sidebar declares
 * 'sidebar.workspaces'. Type-level only: the runtime declaration happens in
 * the TabsRoot register(). The official ui-sidebar is patched out of the
 * profile, so its type declarations are not in this program — the two
 * official holes are restated here with the same owner shares.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /** Official workspace/session browsing region (ui-workspace registers). */
        'sidebar.workspaces': {
            kind: 'single';
            scope: 'root';
            owner: {
                wide: boolean;
                expandSidebar: () => void;
            };
        };
        /** Official settings seat at the sidebar foot (ui-settings registers). */
        'sidebar.settings': {
            kind: 'single';
            scope: 'root';
            owner: {
                wide: boolean;
            };
        };
        /** Terminal tab: xterm.js over the host pty WebSocket (Task 19). */
        'sidebar.tabs.terminal': {
            kind: 'single';
            scope: 'root';
        };
        /** GenOffice tab: relay file list + iframe preview (Task 12-14). */
        'sidebar.tabs.genoffice': {
            kind: 'single';
            scope: 'root';
        };
        /** Files tab: host.listDirectory browser (Task 16). */
        'sidebar.tabs.files': {
            kind: 'single';
            scope: 'root';
        };
    }
}
export {};
//# sourceMappingURL=slots.d.ts.map
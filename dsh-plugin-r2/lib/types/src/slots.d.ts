/**
 * Slot contract for the right-side tab dock, merged into the SlotMap the
 * same way ui-layout declares 'sidebar' / 'details'. Type-level only: the
 * runtime declaration happens in the TabsDock register(). The official
 * ui-sidebar stays mounted on the left (workspace list), so this plugin
 * only claims the three details.* tab slots.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /** Terminal tab: xterm.js over the host pty WebSocket (Task 19). */
        'details.tabs.terminal': {
            kind: 'single';
            scope: 'root';
        };
        /** GenOffice tab: relay file list + iframe preview (Task 12-14). */
        'details.tabs.genoffice': {
            kind: 'single';
            scope: 'root';
        };
        /** Files tab: host.listDirectory browser (Task 16). */
        'details.tabs.files': {
            kind: 'single';
            scope: 'root';
        };
    }
}
export {};
//# sourceMappingURL=slots.d.ts.map
/**
 * Client half of the dsh-genoffice-sidebar plugin: registers the unified
 * sidebar container (TabsRoot) into the layout-owned 'sidebar' slot —
 * replacing the official ui-sidebar shell, which the profile patch disables —
 * and registers the three ecosystem tab panels into the slots TabsRoot
 * declares. The official holes (sidebar.workspaces / sidebar.settings) are
 * re-declared here so ui-workspace / ui-settings keep mounting inside the
 * container (BR-001, INV-001).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Services required by the tabs container and its panels. */
export declare const inject: string[];
/**
 * Register the tabs container and the three ecosystem tab panels.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map
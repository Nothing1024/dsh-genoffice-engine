/**
 * Client half of the dsh-genoffice-sidebar plugin: mounts the right-hand
 * floating dock (终端 | GenOffice | 文件) directly, because the layout-owned
 * `details` column is already claimed by the official conversation-details
 * panel and single slots cannot be shared. The official ui-sidebar stays on
 * the left (workspace list), untouched.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Services required by the dock. */
export declare const inject: string[];
/**
 * Mount the right-hand dock for the plugin's lifetime.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map
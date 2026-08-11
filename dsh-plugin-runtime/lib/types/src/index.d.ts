import type { Context } from 'cordis';
/** Plugin name (host half). */
export declare const name = "genoffice-sidebar-host";
/** Required services: the webserver's upgrade route registry. */
export declare const inject: string[];
/** The ws endpoint path (client connects ws://<host>:<port>/api/pty.ws). */
export declare const PTY_WS_PATH = "/api/pty.ws";
/**
 * Host plugin body: register the /api/pty.ws upgrade route and manage the
 * pty session registry for its lifetime.
 * @param ctx - host root context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map
/**
 * Client half of the dsh-genoffice-sidebar plugin: mounts the right-hand
 * floating dock (终端 | GenOffice | 文件) directly, because the layout-owned
 * `details` column is already claimed by the official conversation-details
 * panel and single slots cannot be shared. The official ui-sidebar stays on
 * the left (workspace list), untouched.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createDockElement, mountDock } from '../TabsDock.tsx'

/** Services required by the dock. */
export const inject = ['workspaces']

/**
 * Mount the right-hand dock for the plugin's lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const host = createDockElement()
    document.body.appendChild(host)
    let dispose: (() => void) | undefined
    try {
      dispose = mountDock(host, (path) => ctx.workspaces.listDirectory(path))
    } catch (err) {
      ctx.logger?.warn?.('[genoffice-sidebar] dock mount failed:', String(err))
    }
    return () => {
      dispose?.()
      host.remove()
    }
  }, 'genoffice-sidebar: right dock mount')
}

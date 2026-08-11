/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

declare global {
  interface Window {
    desktop: DesktopApi
    projectApi: ProjectApi
    /** set by the web bridge (web-bridge.ts); the renderer uses it to show web-only UI */
    __GENOFFICE_WEB__?: boolean
  }
}

export {}

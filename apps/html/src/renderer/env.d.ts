/// <reference types="vite/client" />

import type { ProjectApi } from '@genoffice/project-store'
import type { HtmlApi } from '../shared/ipc'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    htmlApi: HtmlApi
    projectApi?: Pick<ProjectApi, 'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'>
  }
}

export {}

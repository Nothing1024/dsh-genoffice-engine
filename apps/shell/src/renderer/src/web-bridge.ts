/**
 * GenOffice Shell — Web bridge.
 *
 * Stand-in for the Electron preload bridge that lets the *unmodified* shell
 * renderer (Home screen) run in a plain browser tab:
 *
 *   - recents / starred / statPaths  → IndexedDB "genoffice-web" database,
 *     the SAME store the docs web bridge writes, so every document opened in
 *     the browser shows up on the home screen
 *   - openPath / newDoc / ...        → routes to the matching web app tab
 *     (/docs/… etc.; unsupported types report a clear message)
 *   - theme / language               → localStorage (shared with the apps;
 *     storage events sync across tabs)
 *   - account / cloud / update       → stubbed (desktop-only features)
 *
 * This file is only included by the web build (vite.web.config.ts).
 */
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AccountLoginEvent, AccountStatus, CloudProjectsSnapshot, HomeApi, ProjectHomeApi, ProjectSummaryEntry, RecentEntry, RecentPage, RecentQuery, RenameResult, TimelineEntryItem, UiLanguage, UiTheme } from '../../shared/home-api'
import type { TabsApi, TabSummary } from '../../shared/tabs-api'

declare global {
  interface Window {
    __GENOFFICE_WEB__?: boolean
    showOpenFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle[]>
    showSaveFilePicker?: (options?: unknown) => Promise<WebFileSystemHandle>
  }
}

export type WebFileSystemHandle = FileSystemFileHandle & {
  queryPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

window.__GENOFFICE_WEB__ = true

// ────────────────────────────────────────────────────────────
// Shared IndexedDB helpers (same "genoffice-web" DB as the docs bridge)
// ────────────────────────────────────────────────────────────

const DB_NAME = 'genoffice-web'
const DB_VERSION = 1
const STORE_HANDLES = 'handles'
const STORE_CHATS = 'chats'

interface WebFileRecord {
  name: string
  kind: 'fs' | 'bytes'
  handle?: WebFileSystemHandle
  bytes?: ArrayBuffer
  mtime: number
  accessedAt: number
  starred?: boolean
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES)
      if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbAllKeys(store: string): Promise<string[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
  })
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const LANG_KEY = 'genoffice-web-lang'
const THEME_KEY = 'genoffice-web-theme'

const themeListeners = new Set<(theme: UiTheme) => void>()

function readTheme(): UiTheme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function fileName(path: string): string {
  return path.split('/').pop() ?? 'unknown'
}

/** which web app handles this extension; null = not web-enabled yet */
function appForExt(ext: string): string | null {
  switch (ext) {
    case 'docx':
      return 'docs'
    case 'md':
    case 'markdown':
      return 'markdown'
    default:
      return null
  }
}

function notifyUnsupported(ext: string): void {
  const names: Record<string, string> = {
    xlsx: 'Excel 表格',
    pptx: 'PPT 演示文稿',
    pdf: 'PDF 文档',
  }
  const name = names[ext] ?? `.${ext} 文件`
  // eslint-disable-next-line no-alert
  alert(`网页版暂不支持打开 ${name}（仅桌面版可用）。\n当前支持：Word 文档 (.docx)、Markdown (.md)`)
}

function openWebApp(app: string, query?: string): void {
  const base = `/${app}/`
  window.open(query ? `${base}?${query}` : base, '_blank', 'noopener')
}

// ────────────────────────────────────────────────────────────
// Recents (IndexedDB-backed; shared with the docs bridge)
// ────────────────────────────────────────────────────────────

async function recentsPage(
  query: RecentQuery | undefined,
  starredOnly: boolean,
): Promise<RecentPage> {
  const { offset = 0, limit = 50, ext } = query ?? {}
  const keys = await idbAllKeys(STORE_HANDLES)
  const all: RecentEntry[] = []
  for (const path of keys) {
    const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
    if (!rec) continue
    if (starredOnly && rec.starred !== true) continue
    let sizeBytes = 0
    if (rec.kind === 'bytes' && rec.bytes) sizeBytes = rec.bytes.byteLength
    else if (rec.kind === 'fs' && rec.handle) {
      try {
        sizeBytes = (await rec.handle.getFile()).size
      } catch {
        /* keep 0 */
      }
    }
    all.push({
      path,
      name: rec.name,
      ext: extOf(rec.name),
      mtimeMs: rec.mtime ?? 0,
      sizeBytes,
      starred: rec.starred === true,
    })
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const totalAll = all.length
  const filtered = ext ? all.filter((e) => e.ext === ext) : all
  const total = filtered.length
  const page = filtered.slice(offset, offset + (limit || filtered.length))
  return { entries: limit === 0 ? [] : page, total, totalAll }
}

// ────────────────────────────────────────────────────────────
// window.aiOffice (HomeApi)
// ────────────────────────────────────────────────────────────

const aiOffice: HomeApi = {
  recents: (query) => recentsPage(query, false),
  starred: (query) => recentsPage(query, true),

  statPaths: async (paths) => {
    const out: RecentEntry[] = []
    for (const path of paths) {
      const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
      if (!rec) continue
      out.push({
        path,
        name: rec.name,
        ext: extOf(rec.name),
        mtimeMs: rec.mtime ?? 0,
        sizeBytes: rec.bytes?.byteLength ?? 0,
        starred: rec.starred === true,
      })
    }
    return out
  },

  toggleStar: async (path) => {
    const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
    if (!rec) return
    await idbPut(STORE_HANDLES, path, { ...rec, starred: rec.starred !== true })
  },

  openPath: async (path) => {
    const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
    if (!rec) {
      // eslint-disable-next-line no-alert
      alert('文件不在本地浏览器记录中（可能已在其他设备打开，或已被清理）')
      return
    }
    const app = appForExt(extOf(rec.name))
    if (!app) {
      notifyUnsupported(extOf(rec.name))
      return
    }
    openWebApp(app, `open=${encodeURIComponent(path)}`)
  },

  browse: async () => {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [
            {
              description: 'GenOffice 文档',
              accept: {
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
                  '.docx',
                ],
              },
            },
          ],
        })
        const file = await handle.getFile()
        const app = appForExt(extOf(file.name))
        if (!app) {
          notifyUnsupported(extOf(file.name))
          return
        }
        // register the handle in the shared store, then open it
        const path = `/webdoc/${crypto.randomUUID()}/${file.name}`
        await idbPut(STORE_HANDLES, path, {
          name: file.name,
          kind: 'fs',
          handle,
          mtime: file.lastModified,
          accessedAt: Date.now(),
        })
        openWebApp(app, `open=${encodeURIComponent(path)}`)
      } catch (e) {
        if ((e as DOMException)?.name !== 'AbortError') throw e
      }
      return
    }
    // eslint-disable-next-line no-alert
    alert('此浏览器不支持文件选择对话框，请使用 Chrome / Edge')
  },

  newDoc: async () => openWebApp('docs'),
  newSheet: async () => notifyUnsupported('xlsx'),
  newSlide: async () => notifyUnsupported('pptx'),
  newMarkdown: async () => openWebApp('markdown'),
  newPdf: async () => notifyUnsupported('pdf'),

  removeRecent: async (paths) => {
    for (const path of paths) await idbDelete(STORE_HANDLES, path)
  },

  revealPath: async () => {},
  openTrash: async () => {},

  renameFile: async (_path, _newName): Promise<RenameResult> => ({
    ok: false,
    error: '网页版无法重命名磁盘文件，请在文件管理器中操作',
  }),

  duplicateFile: async (path) => {
    const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
    if (!rec) return
    let data: ArrayBuffer | null = null
    let name = rec.name
    if (rec.kind === 'bytes' && rec.bytes) data = rec.bytes
    else if (rec.handle) {
      try {
        const file = await rec.handle.getFile()
        data = await file.arrayBuffer()
        name = file.name
      } catch {
        /* fall through */
      }
    }
    if (!data) {
      // eslint-disable-next-line no-alert
      alert('无法读取原文件内容（权限可能已失效）')
      return
    }
    const dot = name.lastIndexOf('.')
    const copyName = dot < 0 ? `${name}-副本` : `${name.slice(0, dot)}-副本${name.slice(dot)}`
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: copyName })
        const writable = await handle.createWritable()
        await writable.write(data)
        await writable.close()
        const path2 = `/webdoc/${crypto.randomUUID()}/${copyName}`
        await idbPut(STORE_HANDLES, path2, {
          name: copyName,
          kind: 'fs',
          handle,
          mtime: Date.now(),
          accessedAt: Date.now(),
        })
        return
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return
      }
    }
    // eslint-disable-next-line no-alert
    alert('此浏览器不支持保存对话框，请使用 Chrome / Edge')
  },

  deleteFiles: async (paths) => {
    for (const path of paths) {
      const rec = await idbGet<WebFileRecord>(STORE_HANDLES, path)
      const removable = rec?.handle as
        | (FileSystemHandle & { remove?: () => Promise<void> })
        | undefined
      if (removable && typeof removable.remove === 'function') {
        try {
          await removable.remove()
        } catch {
          /* permission denied — just drop the recent entry below */
        }
      }
      await idbDelete(STORE_HANDLES, path)
    }
  },

  getLanguage: async (): Promise<UiLanguage> => {
    const v = localStorage.getItem(LANG_KEY)
    return (v as UiLanguage) ?? 'zh'
  },

  setLanguage: async (lang) => {
    localStorage.setItem(LANG_KEY, String(lang))
  },

  getUpdateChannel: async () => 'stable',
  setUpdateChannel: async () => {},

  accountStatus: async (): Promise<AccountStatus> => ({ loggedIn: false }),
  accountLogin: async () => {
    window.open('https://www.genspark.ai', '_blank', 'noopener')
    return true
  },
  onAccountLogin: (handler: (ev: AccountLoginEvent) => void) => () => {},
  openLoginUrl: async () => {},
  accountLogout: async () => {},

  getAppVersion: async () => '0.1.0-web',

  onboardingSeen: async () => true,
  setOnboardingSeen: async () => true,

  getTheme: async () => readTheme(),
  setTheme: async (theme) => {
    localStorage.setItem(THEME_KEY, theme)
  },
  getAnalyticsEnabled: async () => false,
  setAnalyticsEnabled: async () => false,
  getDefaultSaveDir: async () => '',
  pickDefaultSaveDir: async () => null,
  onThemeChanged: (handler) => {
    themeListeners.add(handler)
    return () => themeListeners.delete(handler)
  },

  openGenTeam: async () => {
    window.open('https://genteam.ai', '_blank', 'noopener')
  },
  openCreditUsage: async () => {
    console.warn('[web-shell] openCreditUsage is not available in the web version')
  },
  openGitHubRepo: async () => {
    window.open('https://github.com/genspark-ai/genoffice', '_blank', 'noopener')
  },
  githubStars: async () => null,
  starPromptShouldShow: async () => ({ show: false, docOpens: 0 }),
  starPromptAction: async () => {},

  cloudProjectsCached: async (): Promise<CloudProjectsSnapshot | null> => null,
  cloudProjectsSync: async (): Promise<CloudProjectsSnapshot | null> => null,
  openCloudProject: async (projectUrl) => {
    window.open(`https://www.genspark.ai${projectUrl}`, '_blank', 'noopener')
  },

  getAiSettings: async () => defaultAiSettings(),
  setAiSettings: async () => {
    console.warn('[web-shell] setAiSettings is not wired in the web version')
  },
  getAiProviders: () => [],
  testAiSettings: async () => ({
    ok: false,
    error: 'AI settings are not available in the web version',
  }),
}

// theme sync across tabs (storage events fire in other same-origin tabs)
window.addEventListener('storage', (e) => {
  if (e.key === THEME_KEY) {
    const theme = readTheme()
    for (const handler of themeListeners) {
      try {
        handler(theme)
      } catch {
        /* ignore */
      }
    }
  }
})

// ────────────────────────────────────────────────────────────
// window.aiOfficeProject (ProjectHomeApi) — minimal IndexedDB impl
// ────────────────────────────────────────────────────────────

const DEFAULT_PROJECT: ProjectSummaryEntry = {
  id: 'web-default',
  name: '网页版项目',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date().toISOString(),
  fileCount: 0,
  lastActiveAt: new Date().toISOString(),
  isDefault: true,
}

const aiOfficeProject: ProjectHomeApi = {
  listProjects: async () => {
    const keys = await idbAllKeys(STORE_HANDLES)
    return [{ ...DEFAULT_PROJECT, fileCount: keys.length, updatedAt: new Date().toISOString() }]
  },
  listFiles: async () => idbAllKeys(STORE_HANDLES),
  createProject: async (name) => ({ ...DEFAULT_PROJECT, name }),
  renameProject: async () => {},
  deleteProject: async () => {},
  moveFile: async () => {},
  getTimeline: async (_projectId, limit): Promise<TimelineEntryItem[]> => {
    const keys = await idbAllKeys(STORE_CHATS)
    const out: TimelineEntryItem[] = []
    for (const key of keys) {
      const messages = (await idbGet<Array<{ ts: string; role: string; text: string }>>(
        STORE_CHATS,
        key,
      )) ?? []
      const [, chatId] = key.split(':')
      messages.forEach((m, i) => {
        if (m.role !== 'user' && m.role !== 'assistant') return
        out.push({
          filePath: key,
          fileName: chatId ?? key,
          chatId: chatId ?? key,
          ts: m.ts,
          role: m.role as 'user' | 'assistant',
          preview: m.text.slice(0, 120),
          seq: i,
        })
      })
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : -1))
    return limit ? out.slice(0, limit) : out
  },
}

// ────────────────────────────────────────────────────────────
// window.aiOfficeTabs (TabsApi) — single home tab
// ────────────────────────────────────────────────────────────

const HOME_TAB: TabSummary = {
  id: 'home',
  kind: 'home',
  title: '首页',
  closable: false,
  active: true,
}

const aiOfficeTabs: TabsApi = {
  list: async () => [HOME_TAB],
  activate: async () => {},
  close: async () => {},
  showMenu: async () => {},
  showNewMenu: async () => {},
  reorder: async () => {},
  onChanged: () => () => {},
  notifyChromePressed: () => {},
  onChromePressed: () => () => {},
}

// ────────────────────────────────────────────────────────────
// Drag & drop: drop a local file onto the home screen to open it
// ────────────────────────────────────────────────────────────

function installFileDrop(): void {
  let overlay: HTMLDivElement | null = null

  const showOverlay = (visible: boolean, label: string) => {
    if (visible && !overlay) {
      overlay = document.createElement('div')
      overlay.textContent = label
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '9999',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '22px',
        fontWeight: '600',
        color: 'var(--color-text-primary)',
        background: 'var(--color-bg-overlay)',
        border: '3px dashed var(--color-border-brand)',
        pointerEvents: 'none',
      })
      document.body.appendChild(overlay)
    } else if (!visible && overlay) {
      overlay.remove()
      overlay = null
    }
  }

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    showOverlay(true, '松开以打开文档')
  })

  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) showOverlay(false, '')
  })

  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files.length) return
    e.preventDefault()
    showOverlay(false, '')
    const item = e.dataTransfer.items?.[0]
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = extOf(file.name)
    const app = appForExt(ext)
    if (!app) {
      notifyUnsupported(ext)
      return
    }
    try {
      const path = `/webdoc/${crypto.randomUUID()}/${file.name}`
      // prefer a real FS handle so saves write back to the original file
      if (
        item &&
        typeof (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle === 'function'
      ) {
        const handle = await (item as DataTransferItem & { getAsFileSystemHandle: () => Promise<WebFileSystemHandle> }).getAsFileSystemHandle()
        if (handle?.kind === 'file') {
          await idbPut(STORE_HANDLES, path, {
            name: file.name,
            kind: 'fs',
            handle,
            mtime: file.lastModified,
            accessedAt: Date.now(),
          })
          openWebApp(app, `open=${encodeURIComponent(path)}`)
          return
        }
      }
      const data = await file.arrayBuffer()
      await idbPut(STORE_HANDLES, path, {
        name: file.name,
        kind: 'bytes',
        bytes: data,
        mtime: file.lastModified,
        accessedAt: Date.now(),
      })
      openWebApp(app, `open=${encodeURIComponent(path)}`)
    } catch {
      /* fall through */
    }
  })
}

// ────────────────────────────────────────────────────────────
// Install
// ────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.aiOffice = aiOffice
  window.aiOfficeProject = aiOfficeProject
  window.aiOfficeTabs = aiOfficeTabs
  installFileDrop()
}

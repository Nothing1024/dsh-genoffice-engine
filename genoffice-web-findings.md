# GenOffice Web 化调研

> 调研对象:https://github.com/genspark-ai/genoffice
> 调研方式:以本地浅克隆源码(本目录,提交 `fd33934d`,Sync snapshot 2026-08-09,#77)为第一手依据,辅以 GitHub Issues/PR API 与公开资料。
> 调研问题:**这个项目能否做成在线(Web)版本,即通过浏览器/Web 触发使用?**

## 结论摘要(TL;DR)

- **官方已确认在做 Web 版**:[Issue #5](https://github.com/genspark-ai/genoffice/issues/5) 中维护者明确回复"已经开始做 Web 版本,目前处于测试阶段,打磨完成后发布"(无时间表)。因此"能否做成在线版本"的答案是**官方路线图内已确认的 yes**——自建/自托管路径详见下文。
- **可以 Web 化,但不是一个"改改配置就能跑"的工程**:渲染层本身是纯 Web(Vite + React,零 `electron` import),引擎包也是纯 TS;**真正被钉死在桌面端的是三样东西**——① 所有文件读写走主进程 `dialog` + `fs`,② sheets 的 Rust sidecar 是"路径参数 + 本地临时文件"的 stdio 协议,③ 所有 AI/搜索调用都刻意经主进程转发以规避 CORS(并有 `child_process` 调 gsk CLI 的部分)。
- **最现实路径是"服务端混合架构"(方案 B)**:renderer 原样打包成静态站点,新增一个 Node 服务复用 `src/main` 里的逻辑(文件 IO、sidecar、AI 转发、PDF 导出),浏览器端写一个 `window.desktop` 的 Web 实现(File System Access API + fetch/SSE/WS)做桥接。估计 **6–12 人周** 做到可用,slides 和 sheets 是大头。
- **最大障碍**:sheets 的 Rust sidecar 与 PPT 引擎的"主进程会话"架构——sidecar 通信协议是文件路径驱动,Web 化必须改成字节流/内存协议(或服务器端驻留);slides 渲染层对主进程 IPC 有 233 处调用、**145 个不同方法名**(`window.slidesApi.*` 139 个 + `window.desktop.*` 6 个),等价于把整个 pptx 编辑会话搬到服务端。
- 授权上 Apache-2.0 对自托管/在线改造**没有任何障碍**(无 AGPL 式网络条款);`ee/` 是企业版边界,目前为空。
- AI 层:`ai-provider` 与 `agent-core` 已 100% 浏览器兼容;gsk 工具(搜索/识图等)走 `child_process` 调 `@genspark/cli`,必须服务端中继;设备码登录协议本身是纯 fetch,但 Set-Cookie 不可读 + Cloudflare 挑战决定了"服务端代跑"更稳。

---

## 1. 渲染层到底有多"纯 Web"(Q1)

### 1.1 结构事实:renderer 零 Electron import,全部能力走 preload 注入的全局对象

六个 app 的 renderer 目录下**没有任何** `from 'electron'` 直接 import(全仓 grep 为 0 命中)。renderer 只通过 preload 注入的全局桥访问桌面能力:

| App | 注入全局 | 定义处 |
|---|---|---|
| docs | `window.desktop` / `window.projectApi` | `apps/docs/src/preload/index.ts:144-145` |
| sheets | `window.desktopApi` / `window.projectApi` | `apps/sheets/src/preload/index.ts:423,438` |
| slides | `window.slidesApi` / `window.desktop`(附件) | `apps/slides/src/preload/index.ts:348,362` |
| pdf | `window.pdfApi` | `apps/pdf/src/preload/index.ts:63` |
| markdown | `window.markdownApi` / `window.projectApi` | `apps/markdown/src/preload/index.ts:71-72` |
| shell | `window.aiOffice` / `aiOfficeProject` / `aiOfficeTabs` / `aiOfficeUpdate` | `apps/shell/src/preload/index.ts:210,245,274` 及 `preload/update.ts:27` |

桥本身只是一层薄封装:如 `apps/docs/src/preload/index.ts:30` `openDocx: () => ipcRenderer.invoke('docs:open')`、`:46-47` `saveDocx: (path, data) => ipcRenderer.invoke('docs:save', ...)`。**对 Web 移植而言,这意味着只要实现一个等价的 Web 桥,renderer 代码基本不用改。**

### 1.2 各能力通道盘点(renderer → 主进程)

| 能力 | 通道(方法) | 主进程实现 | Web 替代方案 | 难度 |
|---|---|---|---|---|
| 打开文件 | `desktop.openDocx/openDocxPath`(`docs:open`) | `dialog.showOpenDialog` + `fs`(`apps/docs/src/main/docs-main.ts:2839-2855`) | File System Access API `showOpenFilePicker`(Chrome/Edge;Firefox/Safari 需 `<input type=file>` 回退) | 低 |
| 保存/另存 | `saveDocx/saveDocxAs/saveDocxNew`(`docs:save`) | `dialog.showSaveDialogWithMemory` + 原子写(`docs-main.ts:2874-`),含"外部修改"冲突检测 | FS Access `showSaveFilePicker` + OPFS;无权限浏览器降级为下载 | 低–中 |
| 崩溃恢复副本 | `writeRecoveryCopy`(`docs:write-recovery`) | 写 userData(`docs-main.ts` recovery 逻辑) | IndexedDB/OPFS 自动备份 | 低 |
| 最近文件/项目列表 | `getRecentFiles`(`docs:recent`)、`projectApi.*` | `packages/project-store`(fs,`src/store.ts:29-30` import `node:fs`/`node:path`)、shell `recent-files.ts`(`statSync` 校验磁盘路径) | localStorage/IndexedDB(路径语义消失,改为"最近打开的文件句柄/对象 URL 列表") | 中 |
| 附件读写(AI 上下文) | `pickAttachments`/`readAttachment`/`readAttachmentImage`(`files:*`) | 主进程 `fs` 读取 | `<input type=file multiple>` + File 对象直达(无需读盘) | 低 |
| 粘贴图片落盘 | `addPastedImage` | 写临时文件(`sheets-main.ts:1488`) | 直接以 Blob/DataURL 进内存或 OPFS | 低 |
| 截图 | `webContents.capturePage()`(`sheets-main.ts:1244-1284`) | 主进程截图当前窗口 | `html2canvas`/`CanvasRenderingContext2D.drawWindow` 不可用 → 用 `dom-to-image` 或 canvas 自绘;或服务端无头 Chromium 截图 | 中 |
| 剪贴板 | slides `slidesApi.nativeClipboard`(`slides-main.ts:2565-2579` `clipboard.readImage/readText`,自定义格式 `io.genoffice.slides.slide` 写 `clipboard.writeBuffer`);sheets 用 Univer DOM 剪贴板(`clipboard-tsv.ts`) | Electron `clipboard` | Web Clipboard API(`navigator.clipboard.read`);**自定义二进制格式无法写入系统剪贴板**,应用内剪贴板改为内存存储 | 中 |
| 主题/语言 | `getTheme/onThemeChanged/getLanguage`(`app:get-theme` 等) | shell `app-settings.json`(userData) | `matchMedia('(prefers-color-scheme)')` + localStorage;`document.documentElement.lang`。renderer 已自带回退:`main.tsx:22-23` `.catch(() => 'zh')` | 低 |
| AI 流式对话 | `aiStream/aiStreamCancel/onAiStream`(`ai:stream`/`ai:stream-chunk`) | 主进程转发模型 API(`docs-main.ts:2510-2521`) | 见 §3:浏览器直连(CORS 风险)或服务端 SSE/WS 中继 | 中–高 |
| 打印 | `print/exportPdf/printPdfBuffer/saveMergedPdf`(`docs:print`/`docs:export-pdf`) | `webContents.printToPDF` + 隐藏窗口(`apps/sheets/src/main/pdf-export.ts:1-40`) | `window.print()`(浏览器"另存为 PDF")或服务端 headless Chromium 打印 | 中 |
| 新标签/多窗口 | `openNewTab/listDocsTabs/focusDocsTab`(`win:*`) | shell `TabManager`(WebContentsView 标签,`apps/shell/src/main/tab-manager.ts`) | SPA 路由/iframe 标签;多窗口用 `window.open` + `BroadcastChannel` | 中 |
| 菜单命令 | `onMenuCommand`(`menu:command`) | shell `Menu.buildFromTemplate`(`shell/src/main/index.ts:2025-2265`) | Web 侧自绘菜单(renderer 已有自绘 Ribbon);原生菜单直接砍掉 | 低 |
| 外部链接 | `shell.openExternal`(`navigation-guard.ts` + `safe-external-url.ts` 白名单守卫) | 主进程打开系统浏览器 | `window.open`/`<a target=_blank>`(浏览器天然沙箱化,守卫可保留为纯 URL 校验) | 低 |

**关键证据:renderer 目前没有 desktop 桥时也能挂载**(`apps/docs/src/renderer/main.tsx:20-31` 对 `getLanguage/getTheme` 逐 promise catch,注释 "standalone runs have no app:get-theme handler");但 `App.tsx:623-624` 无守卫调用 `window.desktop.getRecentFiles()` 会抛未处理 rejection——即**浏览器直跑会启动但功能不全,需要补一个 Web 桥**(sheets 的 renderer 更防御性,大量 `window.desktopApi?.` 可选链)。

**结论**:渲染层"理论上是浏览器可跑的"基本成立——`dev:renderer`(`vite --config vite.renderer.config.ts`)就是纯 Vite 服务器,但它的用途是给 shell 做 HMR 嵌入(`apps/docs/vite.renderer.config.ts` 注释:"embedded by the shell via DOCS_RENDERER_URL for HMR; no standalone Electron")。替换点集中在 **文件系统(dialog+fs→FS Access)、AI 通道(IPC→网络)、剪贴板/截图** 三类,工程量可控;真正的难点不在 UI 而在 §2/§4 的引擎与主进程会话。

---

## 2. Rust sidecar 能否 Web 化(Q2)

### 2.1 通信协议:NDJSON over stdio,参数全是文件路径

- 服务端(二进制):`apps/sheets/native/xlsx-engine/src/main.rs` —— `main()` 逐行读 stdin、写 stdout(`main.rs:113-136`),每行一个 JSON 请求/响应(`Request`/`Response`,带 `version` + `requestId`,`main.rs:86-111`)。
- **协议是路径驱动的**:命令枚举 `Command`(`main.rs:16-84`)中 `Open { path: PathBuf }`、`ConvertWorkbook { path, target_path }`、`SaveArchive { source_path, target_path, ... }`、`RecalcCells { path, ... }` 全部直接吃磁盘路径;会话用 `WorkbookSessions` 维护。
- 客户端:`apps/sheets/src/main/xlsx-sidecar-client.ts` —— `spawn(binaryPath, [], { stdio: ['pipe','pipe','pipe'] })`(`:178-181`),readline 按行解析(`:184-185`),请求超时 30s/归档 180s。
- 上层 IO:`apps/sheets/src/gateway/xlsx-package-io.ts:2-3` `import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'`,`:118` `mkdtemp(join(tmpdir(), 'ai-excel-read-'))`——**所有 xlsx 读写都先落到本地临时文件,再把路径交给 sidecar**,`SaveArchive` 用临时文件 + `rename` 原子提升(`:322-324`)。

### 2.2 依赖分析:两个核心库都"可以"wasm,但协议层是真正的坎

`apps/sheets/native/xlsx-engine/Cargo.toml`:

```toml
calamine = "0.36.0"
ironcalc = "0.7.1"
zip = { version = "4", default-features = false, features = ["deflate"] }
serde_json = "1"
```

- **IronCalc 有官方 wasm/web 绑定**:[ironcalc/web-bindings](https://github.com/ironcalc/web-bindings) 与 npm 包 [`@ironcalc/wasm`](https://www.npmjs.com/package/@ironcalc/wasm)——recalc 逻辑(本项目用 IronCalc 做公式重算,`RecalcCells` 命令)理论上可编译进浏览器。
- **calamine 是纯 Rust**(无 OS 依赖),社区已有 wasm 封装先例,如 [xlsx-wasm-parser(calamine 的 WebAssembly 封装)](https://github.com/remirth/xlsx-wasm-parser);`zip` crate 在 wasm 下也常用内存 Reader。也就是说**crate 本身不构成 wasm 障碍**。
- **真正的障碍是协议与 IO 形状**:① `main.rs` 的命令参数是 `PathBuf`,wasm 沙箱没有文件系统(需 wasi 或改成字节参数);② 上层 gateway 大量 `node:fs` 临时文件编排(`xlsx-package-io.ts` 全文都是);③ 编译目标方面,仓库没有任何 wasm 配置(`.cargo/config.toml` 只做 Windows MSVC CRT 静态链接),`apps/sheets/package.json` 的 `native:build` 就是 `cargo build --release`。
- **可行性分两种**:
  - **服务器端驻留(推荐)**:把 sidecar 原封不动跑在 Node 服务里(或容器),协议从 stdio 改成 HTTP/WebSocket 或保持 NDJSON 走子进程——**零 Rust 改动**,只重写 client 的传输层(`xlsx-sidecar-client.ts` 的 `request()` 是纯 JSON,协议头 `version/requestId/command` 与 HTTP 天然兼容)。
  - **WASM(可选深化)**:把 `main.rs` 的 stdin/stdout 循环换成一个 `run_request(json) -> json` 入口 + 命令参数改为 `ArrayBuffer`/字节(或直接 import calamine 的 `open_reader`/IronCalc JS 绑定,绕过 sidecar 复用其核心逻辑)。量级约 2–4 人周,且要重写 gateway 的全部临时文件逻辑,收益是"纯前端零服务端",但**大文件性能与内存**不如原生/服务端。

---

## 3. AI 层是否浏览器兼容(Q3)

(本节约 30 个证据点来自对 `packages/ai-provider`、`packages/ai-search`、`packages/agent-core`、各 app 主进程 AI IPC 的逐文件核查。)

### 3.1 ai-provider:100% 浏览器兼容 ✅

- 零 Node builtin import;只用 `fetch`/`AbortSignal`/`AbortController`/`crypto.randomUUID()`/`TextDecoder`(`chat.ts:13,35`、`stream.ts:275,832`、`watchdog.ts:45,67`)。
- 流式是标准 SSE:`sseLines()` 用 `ReadableStream.getReader()` + `TextDecoder` 解析(`stream.ts:9-30`),三种协议(Anthropic `/v1/messages`、Gemini `generateContent`、OpenAI 兼容 `/chat/completions`)都是纯 `fetch` POST。连 Anthropic 的浏览器直连头 `anthropic-dangerous-direct-browser-access: 'true'` 都已带上(`stream.ts:280-294`)。
- **自带 key 的入口已存在**:`AI_PROVIDERS` 列表含 genspark/anthropic/gemini/deepseek/openai/custom(`providers.ts:27-88`),`AiSettings.providers[].apiKey`(`types.ts:13-28`);`providers.ts:90-94` 注释明确 "this package has no hardcoded keys"。Genspark 代理是默认:`GENSPARK_LLM_BASE_URLS`(`providers.ts:8-12`),`X-Agent-Type: genoffice` 归属头(`providers.ts:19-25`)。
  - 注意:本快照中 renderer 的 AI 面板只有 Genspark 登录入口(`apps/docs/src/renderer/ai/AiPanel.tsx:950-952` `aiGskLogin`),未见 BYOK 设置 UI;**BYOK 是开放 PR**:[#21 secure BYOK providers](https://github.com/genspark-ai/genoffice/pull/21)("Store credentials with Electron `safeStorage`")、[#17 BYOK + live model catalog](https://github.com/genspark-ai/genoffice/pull/17)、[#46 user-owned AI configuration](https://github.com/genspark-ai/genoffice/pull/46)。

### 3.2 agent-core:纯 Web 平台 ✅

- 零 Node builtin;`AgentLoop` 通过注入的 `AgentTransport`(`types.ts:111-115`)跑,附件是内存 base64(`types.ts:39-43`),工具执行由宿主注入(`skill.ts:30-37`)。唯一的 `electron-transport.ts` 也只是回调注入,浏览器版换一个 `fetch`+SSE 的 transport 即可。

### 3.3 ai-search:混合 ⚠️ —— gsk 工具必须服务端

- **Genspark 设备码登录**(`genoffice-auth.ts`):纯 HTTP 流程——`POST /api/office_addin_auth/device_code?app_type=genoffice` → 打开 `auth_url` 批准 → 轮询 `GET /api/office_addin_auth/token?code=` 至 `approved` → `POST /api/office_addin_auth/session`(Bearer→cookie)→ `POST /api/api_tokens/create` 拿 gsk key(`genoffice-auth.ts:7-12,269-331`)。**协议本身浏览器可跑**(浏览器里用 `window.open`/二维码代替 `shell.openExternal`,`ai-ipc.ts:78-80`),但有三处桌面依赖:
  1. **Token 存储是文件**:`~/.genoffice/auth.json`(`genoffice-auth.ts:113,150-163`,明文 + `mode: 0o600`);
  2. **session cookie 一步浏览器做不到**:`sessionCookie()` 读 `resp.headers.getSetCookie()`(`genoffice-auth.ts:221-229`)——Set-Cookie 是浏览器 fetch 的 forbidden header,且注释说明 Electron `net.fetch` 是为了过 Cloudflare 机器人挑战(`:38-44`);
  3. 因此**登录建议服务端代跑**(Node fetch/undici 带代理),浏览器只负责展示 URL/二维码。
- **gsk 工具(web/image search、图生、转档等)走 `child_process` 调 `@genspark/cli`**:`gsk.ts:179-186` `execFile(process.execPath, [...electronCompatArgs(), entry, ...])`;少量例外(`tool_cli` HTTP 端点 `gsk.ts:346,395-400`、下载 `:443-449`)是纯 fetch。→ **浏览器内不可执行,必须服务端中继或按 `tool_cli` 协议重写**。
- 回退搜索(DuckDuckGo/Serper)是纯 fetch(`index.ts:35-42,123-176`)。

### 3.4 架构事实:AI 全部经主进程转发,renderer 从不直接碰网络

`packages/ai-search/src/index.ts:7`:"Runs in the main process (Node fetch / child process) to avoid renderer CORS."各 app 的 `ai:*` IPC 处理(如 `docs-main.ts:2510-2521` 把 chunk 用 `event.sender.send('ai:stream-chunk', ...)` 推给 renderer)就是为规避 CORS 而设。**Web 版必须提供服务端等价物**(HTTP/SSE 或 WS),`AiStreamChunk`/`AgentTransport` 契约可直接映射,renderer 的 `transport.ts` 只需换实现。

---

## 4. Electron 独有的东西盘点(Q4)

### 4.1 shell(套件壳)

| 能力 | 位置 | 说明 | Web 处置 |
|---|---|---|---|
| 原生应用菜单 | `shell/src/main/index.ts:2025-2265`(多处 `Menu.buildFromTemplate`/`Menu.setApplicationMenu`) | 文件/编辑/视图菜单 + 快捷键 | **砍掉**,renderer 已有自绘 Ribbon/菜单 |
| 自动更新 | `shell/src/main/updater.ts`(electron-updater,stable/beta 双通道,见 [docs/superpowers/specs/2026-08-05-update-channel-design.md](docs/superpowers/specs/2026-08-05-update-channel-design.md)) | `autoUpdater.checkForUpdates`(`updater.ts:306-344`) | **砍掉**(Web 部署即发布);服务端可做"版本检查提示" |
| 打开/保存对话框 | `dialog.showOpenDialog/showSaveDialog` + `@genoffice/electron-utils/dialog-memory.ts` | 各 app 主进程 | FS Access API(§1.2) |
| 外部链接守卫 | `packages/electron-utils/navigation-guard.ts` + `safe-external-url.ts`(协议白名单 `http:/https:` 才放行) | 防 `file:`/`javascript:` 等 | 保留纯 URL 校验即可;浏览器沙箱是天然防线 |
| 多标签(TabManager) | `shell/src/main/tab-manager.ts`(WebContentsView) | WPS 风格标签 | SPA 路由/iframe |
| 单实例锁/userData 迁移 | `index.ts:166-179` | 开发隔离与旧数据迁移 | 砍掉 |
| 云项目同步 | `shell/src/main/cloud-projects.ts`(gskListPastProjects + 本地缓存,`createHash` 按 key 归属) | Genspark 云项目列表 | **Web 版反而更顺**:直接 fetch Genspark API,缓存进 IndexedDB |

### 4.2 各编辑器主进程

| 能力 | 位置 | 说明 | Web 处置 |
|---|---|---|---|
| PDF 导出 | docs `printPdfBuffer`、sheets `apps/sheets/src/main/pdf-export.ts`(隐藏 BrowserWindow + `webContents.printToPDF`) | 打印 HTML → PDF | `window.print()` 或服务端 headless Chromium;pdf-lib 已在依赖里 |
| 打印 | `docs:print` 等 | 系统打印 | `window.print()`(CSS 分页媒体已具备:`apps/sheets/src/renderer/print-html.ts`) |
| 放映(presenter-show) | `apps/slides/src/main/presenter-show.ts`(第二个全屏 BrowserWindow 作 audience 窗口,`win.setFullScreen`,presenter→audience 状态转发) | 双屏放映 | 渲染层已用 Web Fullscreen API(`SlideShowView.tsx:167` `requestFullscreen`);audience 用 `window.open` 新窗 + `BroadcastChannel` 同步——**渲染端(PresenterView/AudienceView 共 1332 行)可直接复用** |
| 系统字体度量 | `apps/slides/src/main/fonts.ts`(`readdirSync` 扫 `/System/Library/Fonts` 等 + opentype.js 解析) | 文档排版/换行精确度量 | **Web 无系统字体**:方案① `FontFace` 加载打包字体/`document.fonts` 度量;② 服务端字体服务(返回字形指标);③ 降级启发式。影响 slides 排版保真度 |
| HarfBuzz 复杂文本整形 | `apps/slides/src/main/shaped-metrics.ts`(harfbuzzjs **wasm**,但吃系统字体文件) | 阿拉伯/泰文等整形度量 | wasm 可复用,字体文件改从服务端/静态资源取 |
| 外部修改检测 | `apps/docs/src/main/external-change.ts`(mtime+size 比对) | 磁盘被其他程序改写的冲突提示 | 服务端做(文件在服务端);浏览器本地文件可省 |
| 崩溃恢复副本 | docs `writeRecoveryCopy`(userData)、sheets 30s recovery(`sheets-main.ts` 注释 "crash-recovery copies save every 30s") | 断电恢复 | IndexedDB/OPFS 快照,机制可平移 |
| 原生剪贴板(自定义格式) | `slides-main.ts:1941` `clipboard.writeBuffer('io.genoffice.slides.slide', ...)` | 跨应用幻灯片复制 | 应用内剪贴板内存化;系统剪贴板仅文本/图片 |
| 窗口标题/打开方式(Finder/Explorer 拖入) | `docs:consume-pending-open`、`docs:opened` | OS 级文件关联 | 砍掉;Web 用拖放/选择文件 |
| `webContents.setWindowOpenHandler` 全拒 | 各 app `create*Window/View` | 防新窗口 | 浏览器 `target=_blank` 行为 + `rel=noopener` |
| 代理设置 | `sheets-main.ts:2801-2830` undici ProxyAgent + `gsk.ts:121-139` 子进程 env | 中国网络代理 | 服务端中继继承此能力;浏览器端靠系统代理 |

### 4.3 小结

**必须砍**:原生菜单、自动更新、单实例锁、OS 文件关联、系统对话框。
**必须替换(有现成 Web 等价物)**:文件 IO→FS Access/上传下载、打印→`window.print()`/服务端、放映 audience→新窗口+BroadcastChannel、剪贴板→Web Clipboard API、主题→`prefers-color-scheme`。
**替换成本高**:系统字体度量(HarfBuzz/opentype.js 在 Web 的字体来源)、`printToPDF`(需服务端 headless 或降级)、sheets 截图(需 canvas 重绘或服务端)。

---

## 5. 授权与合规(Q5)

- **仓库主代码 Apache-2.0**(根 `LICENSE` + `package.json` `"license": "Apache-2.0"`)。Apache-2.0 **没有 AGPL 式的网络使用条款**:自托管、SaaS、在线改造、商用都允许,义务仅是保留版权声明、注明修改、专利授权条款。**Web 化/自托管没有任何许可障碍**。
- **`ee/` 是企业版边界**:`ee/README.md` —— "reserved for future enterprise modules (for example private deployment and offline license verification)",受独立的 [GenOffice Enterprise License](ee/LICENSE) 约束("offering the Enterprise Software to third parties as a hosted or managed service ... requires a valid enterprise agreement")。**目前 `ee/` 只有 LICENSE + README,无代码**;Web 化方案若未来触碰 ee/ 内容需注意授权边界,当前无影响。
- **AI 后端不强制 Genspark**:`ai-provider` 原生支持 Anthropic/Gemini/DeepSeek/OpenAI/OpenAI 兼容自定义端点,自带 key(`providers.ts:27-88`);Genspark 只是默认代理。**BYOK UI 尚未合入**(开放 PR #17/#21/#46,且 #21 计划用 Electron `safeStorage` 加密存 key——Web 版需换成服务端密钥管理或 IndexedDB+用户知情)。gsk 工具的 `@genspark/cli` 依赖在服务端中继时同样可用(env `GSK_API_KEY`,`gsk.ts:87`)。
- **NOTICE/第三方合规**:仓库有 `tools/gen-third-party-notices.mjs` + `tools/check-licenses.mjs` 与 `native/.../deny.toml`(sidecar 依赖许可证门禁)——Web 化若引入新依赖(如 wasm 构建)需过同样的许可证检查。

---

## 6. 仓库内线索与社区讨论(Q6)

### 6.1 仓库内

- `docs/superpowers/specs/` 只有一份设计文档:[2026-08-05-update-channel-design.md](docs/superpowers/specs/2026-08-05-update-channel-design.md)(更新通道设计),与 Web 无关。
- `CLAUDE.md` 是主题规范(设计令牌、暗色模式),无架构/Web 约定。
- 根 `package.json` 有 `ws` 依赖但源码未引用(推测为工具预留);仓库**没有任何服务端/HTTP 业务代码**(唯一 `node:http` 是 sheets 的 127.0.0.1 测试调试服务器,`sheets-main.ts:1248-1294`)——即**项目是纯客户端形态**。

### 6.2 GitHub Issues/PR(2026-08 快照)

- **官方已确认在开发 Web 版**:[Issue #5 "有计划出在线的网页版本吗？"](https://github.com/genspark-ai/genoffice/issues/5)(open,提问者意图正是"部署一个服务端,提供给公司内多个人使用")——维护者 merrick-2002 回复:**"We've already started working on a web version, and it's currently in testing. However, some features still need more polish, so we plan to release it once they're fully refined."**(官方 Web 版已在测试中,打磨完成后发布,未给时间表)。也就是说:官方路线图与本调研的方案方向一致,自建 Web 版要么等官方发布,要么基于本调研路径先行自研(注意后续可能与官方实现竞合)。以下为其他强相关信号:
  - **[PR #64 "Android capacitor port"](https://github.com/genspark-ai/genoffice/pull/64)(open)**:用 Capacitor 把 renderer 包成 Android 应用,新增 `apps/android/`(capacitor.config.ts、vite.config.ts、`docs-platform.ts`/`pdf-android-platform.ts` 平台适配层、editor stubs),并大改 ai-provider 支持 BYOK——**社区已验证"renderer 可以脱离 Electron 跑在 WebView"这个前提**(PR 状态为 WIP,body 是模板)。
  - **[PR #57 Google Docs 风格头部 + Google Drive/Docs 集成](https://github.com/genspark-ai/genoffice/pull/57)(open)**:OAuth + Drive 文件列表 + 上传同步——方向上是"云端文件"。
  - **BYOK 三连**:[#21](https://github.com/genspark-ai/genoffice/pull/21)(safeStorage 存 key,直接 OpenAI 兼容端点)、[#17](https://github.com/genspark-ai/genoffice/pull/17)、[#46](https://github.com/genspark-ai/genoffice/pull/46)(Settings 窗口:Model/Search/Proxy/Rules/Skills/Browser)。
  - [#31 "add A2A transport to agent-core"](https://github.com/genspark-ai/genoffice/pull/31)(open)、[#33 "arch: lift ai panel state to main process"](https://github.com/genspark-ai/genoffice/pull/33)(open) 等架构演进。
- 外部报道(它思否/It's FOSS/论坛)均围绕桌面版与 AI 能力,未提 Web 计划。

---

## 7. 三条可行路径的工程评估(Q7)

### 方案 A:纯浏览器端移植(renderer 直跑 + FS Access + sidecar→WASM)

- **做法**:renderer 原样打包静态站点;写一个 Web 版 `window.desktop` 桥(FS Access/OPFS/下载 + 剪贴板 + 主题);sidecar 重写为 wasm(字节协议)或改用 IronCalc JS 绑定 + calamine wasm;AI 在浏览器直连(Genspark 代理或 BYOK 端点,依赖 CORS)。
- **工作量**:10–16 人周(不含打磨);其中 sidecar Web 化 2–4 人周、sheets gateway 重写 2–3 人周、各 app 桥 2–4 人周、AI 直连与登录改造 2–3 人周、字体度量 1–2 人周。
- **风险(高)**:
  - gsk 工具(搜索/识图/转档)无法浏览器执行(§3.3),AI 体验断腿——要么放弃这些工具,要么仍要一个轻量中继,那样就不纯了;
  - Genspark 登录的 Cloudflare 挑战 + Set-Cookie 问题(§3.3);
  - CORS:Anthropic/OpenAI 官方端点浏览器可直连(代码已带 direct-browser-access 头),但 Gemini `x-goog-api-key` 在浏览器暴露即泄露——**BYOK 密钥安全是硬伤**;
  - 系统字体缺失导致 slides 排版保真度下降;
  - 大 xlsx 在 wasm 中内存/性能瓶颈。
- **适合**:原型验证、纯本地单机场景(如"浏览器里的离线单文件编辑")。

### 方案 B:服务端混合架构(推荐)✅

- **做法**:
  1. renderer 包成静态前端(现有 `vite.renderer.config.ts` 产物),新增 `window.desktop` Web 桥:文件打开/保存用 FS Access(本地优先)或服务端文件 API(云端优先);
  2. 新增一个 Node 服务(可复用 `apps/*/src/main` 的大量逻辑):sidecar 以子进程/容器驻留(零 Rust 改动,`xlsx-sidecar-client.ts` 只换传输层:stdio→HTTP/WS,协议 JSON 形状不变)、AI 转发(`ai:stream`→SSE/WS,chunk 契约不变)、gsk CLI 工具、`printToPDF`(headless Chromium)、PDF 合并、云项目同步;
  3. 登录:服务端代跑设备码(§3.3),前端弹 URL/二维码。
- **工作量**:6–12 人周 MVP(前端桥 2–3、AI 服务 1–2、文件/附件服务 1–2、sheets sidecar 服务化 1–2、slides 会话服务化 2–3、PDF 导出 1),再到"对标桌面体验"再 +4–8 人周(slides 保真、字体、多端协作可选)。
- **风险(中)**:slides 的 233 处调用/145 个方法名服务化是最大单项;多用户并发写同一文件需加锁/版本(桌面版是单用户,`external-change.ts` 已有冲突检测可借鉴);服务端要处理密钥存储(替代 safeStorage)与速率限制。
- **最大优点**:**桌面版与 Web 版共享同一套引擎代码**,主进程逻辑 80%+ 可原样搬到服务端(它们本来就是 Node 代码),后续可做多端(Web/桌面/移动)同构。

### 方案 C:云端桌面流(容器 + Xvfb + noVNC/WebRTC)

- **做法**:Docker 里跑现有 Electron 应用(Xvfb/虚拟显示),浏览器经 noVNC(或 WebRTC 自研流)操作远程桌面;几乎零代码改动。
- **工作量**:1–3 人周(打包 + 容器 + 会话管理),但**每个用户一个容器实例**,GPU/内存开销大,输入延迟受网络影响,移动端体验差。
- **风险**:成本(单实例内存 1–2GB+)、合规(Genspark 登录每实例)、体验(缩放/滚动/IME)。
- **适合**:临时演示、私有内网"桌面即服务",不适合作为产品形态。

### 推荐

**方案 B**。理由:① renderer 纯 Web 的事实让"UI 复用"成本最低;② 主进程本身就是 Node 代码,服务化是搬运不是重写;③ sidecar 协议 JSON 化让 Rust 侧零改动;④ 与社区方向(PR #64 capacitor、#57 Drive、BYOK)兼容,可渐进落地(先 docs/markdown,再 pdf,最后 sheets/slides)。

### 主要风险排序

1. **slides 主进程会话服务化**(IPC 面最大,排版保真依赖系统字体);
2. **sheets sidecar 的路径协议**(改成字节/服务端驻留,含 gateway 临时文件重写);
3. **AI 通道**(gsk CLI 工具与登录的 Cloudflare/Set-Cookie,必须服务端);
4. **密钥安全**(BYOK 在 Web 的存储与暴露);
5. **打印/导出 PDF 保真**(`printToPDF` → headless 或浏览器打印)。

---

## 附录:关键证据索引(文件 → 行号)

- renderer 零 Electron import:各 `apps/*/src/renderer` 全量 grep 无 `from 'electron'`。
- preload 桥:`apps/docs/src/preload/index.ts:14-145`(desktop+projectApi)、`apps/sheets/src/preload/index.ts:423,438`、`apps/slides/src/preload/index.ts:348,362`、`apps/pdf/src/preload/index.ts:63`、`apps/markdown/src/preload/index.ts:71-72`、`apps/shell/src/preload/index.ts:210,245,274`。
- docs renderer 无守卫调用:`apps/docs/src/renderer/App.tsx:623-624`;有守卫挂载:`apps/docs/src/renderer/main.tsx:20-31`。
- sidecar 协议:`apps/sheets/native/xlsx-engine/src/main.rs:16-84,113-136`;客户端:`apps/sheets/src/main/xlsx-sidecar-client.ts:148-205`;临时文件:`apps/sheets/src/gateway/xlsx-package-io.ts:2-3,118,137-197,322-324`;Cargo 依赖:`apps/sheets/native/xlsx-engine/Cargo.toml`。
- ai-provider 纯 Web:`packages/ai-provider/src/stream.ts:9-30,275-294`、`providers.ts:8-12,27-108`、`types.ts:13-28`。
- 设备码流程:`packages/ai-search/src/genoffice-auth.ts:7-12,269-331`;token 文件存储 `:113,150-163`;net.fetch 动机 `:38-59`;gsk CLI `packages/ai-search/src/gsk.ts:179-186,346,395-400`。
- AI 主进程转发:`apps/docs/src/main/docs-main.ts:2510-2521`;`packages/ai-search/src/index.ts:7`;登录开浏览器 `apps/slides/src/main/ai-ipc.ts:78-80`。
- shell 菜单/更新/外链:`apps/shell/src/main/index.ts:2025-2265`、`updater.ts:306-344`、`apps/shell/src/main/cloud-projects.ts`;守卫 `packages/electron-utils/navigation-guard.ts`、`safe-external-url.ts`。
- 放映:`apps/slides/src/main/presenter-show.ts:36-106`;渲染端 Fullscreen API `apps/slides/src/renderer/components/SlideShowView.tsx:159-167`。
- 字体:`apps/slides/src/main/fonts.ts:1-50`;HarfBuzz wasm `apps/slides/src/main/shaped-metrics.ts:1-20`。
- PDF 导出:`apps/sheets/src/main/pdf-export.ts:1-40`;打印 HTML `apps/sheets/src/renderer/print-html.ts`。
- 授权:`LICENSE`(Apache-2.0)、`ee/README.md`、`ee/LICENSE`。
- 社区信号:[Issue #5 官方 Web 版确认](https://github.com/genspark-ai/genoffice/issues/5)(open,提问者"部署服务端供公司内多人使用",维护者 merrick-2002 2026-08-03 回复"we've already started working on a web version, and it's currently in testing... plan to release it once they're fully refined")、[PR #64 capacitor](https://github.com/genspark-ai/genoffice/pull/64)、[#57 Drive](https://github.com/genspark-ai/genoffice/pull/57)、[#21 BYOK](https://github.com/genspark-ai/genoffice/pull/21)、[#17](https://github.com/genspark-ai/genoffice/pull/17)、[#46](https://github.com/genspark-ai/genoffice/pull/46)。
- 外部资料:[IronCalc web-bindings](https://github.com/ironcalc/web-bindings)、[`@ironcalc/wasm`](https://www.npmjs.com/package/@ironcalc/wasm)、[xlsx-wasm-parser(calamine wasm 先例)](https://github.com/remirth/xlsx-wasm-parser)。

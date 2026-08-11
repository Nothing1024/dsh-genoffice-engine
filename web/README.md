# GenOffice 网页版（Web）

让 [GenOffice](https://github.com/genspark-ai/genoffice) 无需 Electron、直接在浏览器里运行。
各 app 的 renderer 代码零修改 —— 每个 app 只新增一个 Web 桥（替代 Electron preload 注入的
全局对象）和一个小型中继服务。

**已 Web 化**：套件主页（shell Home）、AI Docs（Word 文档）、AI Markdown。
**待 Web 化**：Sheets（Rust sidecar）、Slides（233 处 IPC）、PDF（printToPDF）。

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  浏览器 (Vite 构建)      │  /api  │  web/server.mjs (Node 22+)  │
│  /          → shell 主页 │ ─────▶ │  - 静态托管各 app web-dist   │
│  /docs/     → AI Docs   │        │  - 联网搜索 / 图片搜索       │
│  /markdown/ → Markdown  │        │  - 图片抓取 (fetch-image)    │
│  ├─ web-bridge.ts       │        └──────────────────────────────┘
│  ├─ FS Access 打开/保存 │
│  ├─ IndexedDB（共享）    │
│  └─ AI 直连 (BYOK)      │
└─────────────────────────┘
```

主页与各编辑器**同源共享 IndexedDB**（`genoffice-web` 库）：在主页打开/编辑过的文件，
会出现在"最近使用"和"收藏"里；点击最近文件在新标签页打开对应编辑器。

## 快速开始

```bash
npm ci --ignore-scripts   # 无需 electron 二进制，仅 web 构建需要
npm run web               # 构建（shell + docs + markdown）+ 启动 → http://localhost:8787
```

## 网页版能力对照

| 能力 | 桌面版 | 网页版 |
|---|---|---|
| 主界面（主页） | shell Home + 原生标签 | shell Home 原样运行（单一"首页"标签）；
  最近文件 / 收藏 / 项目计数 / 新建卡片 / 打开本地文件 |
| 新建文档 | 各模块窗口 | AI Docs ✅ / AI Markdown ✅；Sheets/Slides/PDF 显示"仅桌面版"提示 |
| 打开 .docx / .md | 系统对话框 | 主页卡片或编辑器内 File System Access API（Chrome/Edge）；
  其他浏览器 `<input type=file>` / 下载回退 |
| 拖拽打开 | Finder/Explorer 拖入窗口 | **浏览器原生拖拽**：把本地 .docx/.md 拖到主页或任意编辑器，
  松开即在新标签页打开（Chromium 下用 `getAsFileSystemHandle()` 保留原文件句柄，
  保存直接写回原文件） |
| 保存 / 另存为 | 系统对话框 + 原子写 | FS Access `createWritable`；无权限时自动下载 |
| 自动保存 | 主进程 + 崩溃恢复副本 | 同一套 renderer 自动保存逻辑；恢复副本存 IndexedDB |
| 最近文件 / 星标 | userData 磁盘列表 | IndexedDB 句柄 + 内存注册表（跨 app 共享） |
| 重命名 / 复制 / 删除 | 磁盘操作 | 复制 = 另存副本 ✅；重命名 = 不支持（提示）；
  删除 = 尽力删除 + 移除记录 |
| AI 对话/流式 | 主进程转发 | **浏览器直连**（`@genoffice/ai-provider` 本来就是纯 Web 代码），
  需自带 API Key（docs/markdown 面板 ⚙ 配置，两 app 共享） |
| 联网/图片搜索 | gsk CLI | 本地中继服务（DuckDuckGo / Bing） |
| 打印 / 导出 PDF | `printToPDF` | `window.print()`（打印对话框可另存为 PDF）；
  Markdown→docx 导出 = 另存对话框 ✅；混合纸张分组合并导出暂不支持 |
| 附件 | 主进程 fs | 浏览器文件选择/拖放；docx/pptx/xlsx/txt 文本提取在浏览器内完成（PDF 暂不支持） |
| 主题 / 语言 | app-settings.json | localStorage（跨标签页 storage 事件自动联动） |

## 本机文件 → 网页版

浏览器不能直接读取任意磁盘路径（安全沙箱），本机打开文件有三条路：

### 1. 命令行（推荐）：`npm run open -- <文件>`

```bash
npm run open -- ~/Desktop/报告.docx   # 自动打开浏览器 → /docs/ 编辑器
npm run open -- ./notes.md            # → /markdown/ 编辑器
```

原理：CLI（`web/open.mjs`）把文件字节注入本地中继（`POST /api/inject`，一次性 token、
30 分钟 TTL），再用系统浏览器打开 `?open=inject:<token>`，页面从中继拉回字节并在
IndexedDB 注册。中继没在跑时 CLI 会自动拉起。`--no-browser` 只打印 URL（供脚本使用）。

> 注：注入的文件是副本——保存会下载新文件；要**写回原文件**请用拖拽打开
> （Chromium 下 `getAsFileSystemHandle()` 保留原文件句柄）。

### 2. 服务端目录（部署场景）

```bash
GENOFFICE_WEB_FILES_ROOT=/srv/genoffice-files node web/server.mjs
# 然后深链接： /docs/?open=server:报告.docx
```

### 3. 拖拽 / 文件选择器（手动）

拖到主页或编辑器页面、主页"打开本地文件"、编辑器 `Ctrl+O`。

## URL 驱动打开（深链接 / RESTful）

任何文档都可以通过 URL 触发打开，方便从其他系统、消息、书签跳转：

| 形态 | 示例 | 说明 |
|---|---|---|
| 查询参数 | `/docs/?open=<target>` | 原始形态（主页/新标签页使用） |
| 别名 | `/docs/?file=<target>` | `open` 的别名 |
| RESTful 路径 | `/docs/f/<base64url>` | 深链接友好；`base64url` 是 target 的 base64url 编码（UTF-8） |

`<target>` 支持四类值：

| target | 含义 | 示例 |
|---|---|---|
| `/webdoc/<id>/<name>` | 本浏览器 IndexedDB 里的文件（含真实磁盘句柄） | `?open=/webdoc/abc123/报告.docx` |
| `path:<绝对路径>` | **本机任意磁盘路径**，relay 按路径读取（loopback 默认允许；网络暴露需 `GENOFFICE_WEB_OPEN_PATHS=1`） | `?open=path:/Users/me/报告.docx` |
| `https://host/file` | 远程文件，经中继 `/api/fetch-file` 代理拉取（无 CORS 限制） | `?open=https://files.example.com/report.docx` |
| `data:...;base64,...` | 内联字节 | `?open=data:application/octet-stream;base64,UEsDB...` |
| `server:<relpath>` | 中继主机上的文件（需配置白名单，见下） | `?open=server:docs/报告.docx` |
| `inject:<token>` | `npm run open -- <file>` 注入的本地文件（一次性） | `?open=inject:a1b2...` |

`path:` 形态是给"从外部环境（终端、DSH agent、其他应用）快速传递真实路径"用的——
拿到路径即可生成可点击的深链接，浏览器经 relay 读取字节打开（本机场景默认开放，
因为 relay 只监听 127.0.0.1；对外暴露时必须显式开启，避免任意文件读取）。

打开后参数自动从地址栏清除（刷新不会重复打开）。目标类型与编辑器不匹配时安全忽略
（如 `.md` 传给 `/docs/`）。

### 服务端文件（可选）

中继支持从服务器磁盘打开文件，用于"文件存在服务器上"的部署：

```bash
GENOFFICE_WEB_FILES_ROOT=/srv/genoffice-files node web/server.mjs
```

启用后 `GET /api/files?path=<relpath>` 只允许访问该根目录内的文件（`..` 越权返回 403），
配合 `?open=server:<relpath>` 使用。默认**禁用**，不配置环境变量时该接口不可用。

## AI（BYOK）配置

网页版不使用 Genspark 账号登录（设备码 + Cloudflare 会话只能在服务端跑）。改为自带
Key：打开 AI 面板 → 右上角 ⚙ → 选择模型服务商，填入 API Key / 模型（自定义端点可填
Base URL）→ 保存。密钥只存本浏览器 localStorage，请求由浏览器直连服务商 API：

- **DeepSeek / OpenAI 兼容端点（含自定义）**：一般可直接浏览器直连；
- **Anthropic**：官方支持浏览器直连（`anthropic-dangerous-direct-browser-access`）；
- **Gemini**：浏览器直连需服务端配置 CORS（`x-goog-api-key` 暴露在浏览器端）；
- **Genspark 代理**：桌面版专属，网页版不可用。

## 中继服务（可选）

`web/server.mjs` 零依赖（Node ≥ 22 内置 fetch），同时负责静态托管与浏览器做不了的
能力。不启动它，编辑器本身（含本地文件、AI 直连）仍完全可用，仅联网搜索/图片搜索/图片
抓取会提示"需要中继服务"。

## 如何为其他 app 做 Web 化

架构与 Docs 完全一致，每个 app 三步：

1. `apps/<app>/src/renderer/<app>-web-bridge.ts` —— 实现 preload 注入的全局对象
   （`window.desktopApi` / `window.slidesApi` / `window.pdfApi` / `window.markdownApi`），
   浏览器 API 替换 IPC；
2. `apps/<app>/vite.web.config.ts` —— 复制 `apps/docs/vite.web.config.ts`（注入桥 +
   放宽 CSP + `base: '/<app>/'`）；
3. 在 `web/server.mjs` 的 `findStaticRoots()` 列表中加入该 app（已含全部）。

已知难点（详见 `genoffice-web-findings.md`）：

- **sheets**：xlsx 读写依赖 Rust sidecar（`apps/sheets/native/xlsx-engine`，stdio 路径
  协议）。推荐把 sidecar 原样跑在中继服务里（`xlsx-sidecar-client.ts` 只换传输层），或
  编译 wasm（IronCalc 有官方 web 绑定）；
- **slides**：renderer 对主进程有 233 处 IPC 调用（145 个方法名），需要把排版会话搬到
  服务端；系统字体度量需 `FontFace` 加载或服务端字体服务；
- **pdf**：依赖主进程 `printToPDF` 与 pdfjs 页面渲染，Web 端需服务端 headless Chromium
  或浏览器内 pdfjs + 降级打印。

## 验证

```bash
node web/smoke-test.mjs         # docs：挂载/输入/桥往返/主题/搜索
node web/e2e-open-save.mjs      # docs：打开真实 .docx → 渲染 → 修改 → Ctrl+S 保存回写
node web/e2e-home.mjs           # 主页：桥往返/最近文件/星标/计数
node web/e2e-cross-app.mjs      # 主页 → 打开 .md/.docx → 各编辑器加载内容
node web/e2e-dragdrop.mjs       # 拖拽 .md/.docx 到主页/编辑器 → 新标签打开 → 进入最近列表
node web/e2e-url-open.mjs       # URL 打开：?open= / ?file= / RESTful /f/ / 远程 https / server:
```

## 目录

```
apps/shell/src/renderer/src/web-bridge.ts   # 主页桥（aiOffice / aiOfficeProject / aiOfficeTabs）
apps/shell/vite.web.config.ts               # 主页 Web 构建
apps/docs/src/renderer/web-bridge.ts        # Docs 桥（window.desktop / projectApi）
apps/docs/vite.web.config.ts                # Docs Web 构建
apps/markdown/src/renderer/web-bridge.ts    # Markdown 桥（window.markdownApi）
apps/markdown/vite.web.config.ts            # Markdown Web 构建
apps/*/web-dist/                            # 构建产物（gitignore）
web/server.mjs                              # 静态托管 + 中继（搜索/图片）
web/*.mjs                                   # Playwright 验证脚本
```

## 许可

仓库本身 Apache-2.0；`ee/` 为企业版边界（当前为空）。Web 化改造无许可障碍，注意保留
原 LICENSE 与 NOTICE。

# DSH 侧边栏统一生态（GenOffice 快速预览插件）Spec

> Version: 0.1.0 | Date: 2026-08-10 | Status: Skeleton 骨架（Stage 1）
>
> 本文件是本需求的**唯一事实源**：事实基线、业务合同、技术方案、任务计划、验收协议全部在此。
> 其他文件（handoff.md、tasks.csv）只引用本文件，不复制内容。
>
> 填写三态规则：每个表格单元格只允许三种内容——
> 1. 验证过的事实（注明来源命令）；2. 显式假设 `ASM-xxx`；3. `待勘察`。
> 禁止编造看似合理的命令、symbol、文件名。

---

## 1. 事实基线与假设

### 1.1 需求与运行模式

| 项 | 结论 |
|---|---|
| 原始需求 | 给 DSH 增加"统一侧边栏生态"：侧边栏选项卡可切换类 terminal / GenOffice / 文件管理；自带文件浏览器；点击文件在侧边栏内嵌（iframe）打开 GenOffice 预览（只读，暂不写回），支持"在浏览器中打开"跳转；任务包交给另一个 Agent 执行（handoff） |
| 输入类型 | 对话上下文推断（多轮确认：文件浏览器自带 / 选项卡 / 嵌入+跳转 / 仅浏览） |
| Mode | oneclick |
| 置信度 | 高 |
| 输出目录 | `docs/dsh-sidebar-ecosystem/` |

### 1.2 任务类型路由

| 维度 | 结论 |
|---|---|
| 任务类型 | frontend（DSH 侧边栏插件 UI）+ backend（genoffice relay /api/dir + CORS）+ infra（插件包构建与 profile 加载） |
| 主要风险 | ① 替换 `ui-sidebar` 注册者后官方工作区/设置面板需自绘容器保留；② 本地插件包加载链路未实测（ASM-001）；③ 终端是唯一无现成 client 的部件（node-pty host ws + xterm.js 自建）；④ DSH 版本 API 演进（基于 test-Nothing1024 快照 c15895f 开发） |
| 行号引用策略 | 中：业务/前端以 symbol + rg anchor 为主，行号仅 hint；DSH 源码引用全部以 rg anchor 为准 |
| 必需验收方式 | browser（Playwright 实测 DSH GUI）+ curl（relay API）+ 截图/console 三件套 |
| 必须覆盖用户场景 | UF-001~UF-006 全部（选项卡切换 / GenOffice 预览 / 浏览器打开 / 文件管理 / 终端 / 折叠恢复） |

### 1.3 勘察事实清单

| 事实 | 来源命令 | 输出摘要 |
|---|---|---|
| DSH 开发 worktree 已建：`genoffice/.dsh-plugin-dev` @ c15895f，分支 `genoffice-web-plugin`，基于 test-Nothing1024 快照 | `git worktree add -b genoffice-web-plugin ...` + `git rev-parse --short HEAD` | c15895f，worktree 列表含 `.dsh-plugin-dev` |
| 槽位架构：`ui-layout` 注册 `root` 槽位，children = `sidebar`(scope root) / `conversation`(scope session-maybe) / `details`(scope session)；AppFrame 渲染 `renderSlot('sidebar', {collapsed,width})` | `grep -n "'details'" packages/client/ui-layout/src/client/index.ts` | L43 `'details': { kind: 'single'; scope: 'session'; ... }`；L85 children 声明 |
| `ui-sidebar` 是 `sidebar` 槽位唯一注册者（kind single），children = `sidebar.workspaces` + `sidebar.settings`；SidebarRoot 渲染 `renderSlot('sidebar.workspaces')`(L174) 与 `renderSlot('sidebar.settings')`(L182)，折叠时保留 56px rail | `grep -n "name: 'sidebar'" packages/client/ui-sidebar/src/client/index.ts` + `grep -n "renderSlot" packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | index.ts L39 `name: 'sidebar'`；SidebarRoot.tsx L174/L182 两个子槽位渲染点 |
| 第三方面板注册标准模式：`ctx.slots.inject('<父槽位>', () => ctx.slots.register({name, children, inject, store, locale}, Component))` | `sed -n '95,135p' ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/src/client/index.ts` | L107 `ctx.slots.inject('sidebar.workspaces', ...)` 注册 WorkspaceBrowser |
| 浏览器→host API 通道：`ctx.connection.api`（IApiClient，WebApiClient/FixtureApiClient），`host.listDirectory(path?) → RpcResponse<DirectoryListing>` | `grep -n "listDirectory" ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/src/api/host.ts` | L69-72；DirectoryListing = 一层目录 + ancestry |
| node-pty 在 DSH 依赖树中可用（dsh-pty-local 依赖 node-pty ^1.1.0）；dsh-pty 是 host 侧 Service（PTY 注册表），无 client 传输层 | `grep -n "node-pty" packages/pty/pty-local/package.json` + `head -50 packages/pty/pty/src/index.ts` | pty-local L42 `"node-pty": "^1.1.0"`；pty 为 Service，需自建 ws 通道 |
| 插件加载：profile 目录 `$DSH_HOME/profiles/<name>/` 由 `dsh web --profile` 启动（apps/cli/src/profile-boot.ts, args.ts L101）；bundle 组合在 `package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml`（patch 以 id 行 insert/disable） | `cat ~/.dsh/profiles/web/package.json` + `head -60 ~/.dsh/profiles/web/cordis.patch.yml` | bundles = dsh-base + dsh-web-app；patch 用 `- id: xxx` / `- insert:` 列表 |
| genoffice relay（web/server.mjs）现状：Node22 零依赖；默认绑定 127.0.0.1（`HOST` 环境变量可改）；已有 `/api/health|search/web|search/image|fetch-image|fetch-file|files|file|inject`；`/api/file`（绝对路径）默认 loopback 允许、网络暴露需 `GENOFFICE_WEB_OPEN_PATHS=1`；**无任何 CORS 响应头** | `grep -n "Access-Control\|ALLOW_ABS_PATHS\|listen(PORT" web/server.mjs` | 无 Access-Control-* 输出；L~350 `server.listen(PORT, HOST, ...)` |
| genoffice URL 打开链路已实现并全绿：`?open=` / `?file=` / `/f/<base64url>`；target 支持 `/webdoc/`、`path:`、`https:`、`data:`、`server:`、`inject:`；打开后 URL 自动清理 | `node web/e2e-url-open.mjs` | 六形态全部通过，无 console error |
| DSH web 前端构建入口：apps/web（vite），dist 由 apps/cli `dsh web` 服务；未发现 Content-Security-Policy / frame-src 配置 | `grep -rn "frame-src\|Content-Security" apps/web packages/host` | 无命中 |
| genoffice docs renderer 存在 readMode 状态（只读模式候选），但无 `?view=` 参数接线 | `grep -n "readMode" apps/docs/src/renderer/App.tsx` | readMode 变量存在，接线 `待勘察` |

### 1.4 假设清单

| 假设 ID | 内容 | 风险 | 确认方式 |
|---|---|---|---|
| ASM-001 | 本地插件包可通过 `profiles/web/package.json` 的 `file:` 依赖 + pnpm install 链接进 `~/.dsh/profiles/web/node_modules`，patch 行以包名引用即可被 client boot 加载 | 高：若 profile 安装机制不接受本地链接，需改用发布/符号链接 | P0 冒烟插件（hello 面板）实测 |
| ASM-002 | DSH web 页面无 CSP frame-src 限制，`<iframe src="http://localhost:8787/...">` 可正常嵌入 | 中：若有隐藏响应头限制则需改嵌入方式 | P0 实测（Playwright 开 DSH GUI 注入 iframe） |
| ASM-003 | 替换 `ui-sidebar` 注册者后，官方 SidebarRoot 的 rail 图标/交互无法复用（组件未导出），需自绘简化版 | 中：样式保真度下降 | P0 检查 `ui-sidebar/src/client/index.ts` 导出面；视觉验收 |
| ASM-004 | GenOffice 预览用 `path:` 打开（relay 读字节副本），侧边栏 iframe 内仅只读浏览；保存=下载新文件，不写回原文件 | 低：用户已确认"暂时仅浏览" | 5.2 真实场景确认保存行为 |
| ASM-005 | 终端 tab 用 host 侧 cordis 插件（node-pty spawn shell + `/api/pty.ws` WebSocket）+ client xterm.js 渲染；pty 会话与面板关闭联动销毁 | 高：node-pty 原生模块需在 DSH host 进程加载；ws 握手与 DSH 现有 httpServer 集成细节待勘察 | P5 任务内勘察 `packages/pty/pty/src` PtySpawnRequest 字段 + DSH httpServer 注册方式 |

---

## 2. 业务合同

### 2.1 BR 业务规则

| 规则 ID | 规则 | 正例 | 反例 | 影响范围 | 验证方式 |
|---|---|---|---|---|---|
| BR-001 | 侧边栏选项卡容器是 `sidebar` 槽位的唯一注册者（通过 patch disable 官方 `ui-sidebar` 行 + insert 本插件）；官方工作区/设置面板以子槽位形式在容器内继续渲染 | 加载插件后侧边栏出现选项卡栏且"工作区"tab 内能看到官方会话列表 | patch 未 disable 官方行 → 双注册冲突（single 槽位报错）或官方面板消失 | DSH profile 加载层 | browser 实测 + console 无错 |
| BR-002 | 每个 tab 面板是可插拔子槽位 `sidebar.tabs.<name>`（kind single, scope root）；任何插件可用 `ctx.slots.inject('sidebar.tabs', ...)` 注册新 tab | 未来插件注册 `sidebar.tabs.music` 后选项卡栏出现新 tab | 面板代码写死进容器组件，无法扩展 | 容器组件 | 代码审查 + 冒烟注册测试 tab |
| BR-003 | 选项卡栏至少包含：工作区、终端、GenOffice、文件；激活 tab 在会话内保持（侧边栏折叠/展开后恢复原 tab） | 切到 GenOffice → 折叠 → 展开 → 仍显示 GenOffice | 折叠后回到默认 tab | 容器组件 | browser 实测 |
| BR-004 | GenOffice 面板文件列表数据源为 relay `GET /api/dir?path=`；默认列用户主目录；目录切换、上级导航、文件类型过滤可用 | `curl /api/dir?path=/tmp` 返回 entries | 返回非 JSON 或 500 | genoffice relay | curl 实测 |
| BR-005 | relay `/api/dir` 与 `/api/file` 同安全策略：默认 loopback 允许任意路径；`HOST` 非 loopback 时需 `GENOFFICE_WEB_OPEN_PATHS=1` 才启用 | 默认 `curl http://localhost:8787/api/dir?path=/tmp` 200 | `HOST=0.0.0.0` 且无开关时返回禁用错误 | genoffice relay | curl 实测（两种配置） |
| BR-006 | relay 对跨域请求（Origin 为 `http://localhost:*` / `http://127.0.0.1:*`）返回 CORS 头（Access-Control-Allow-Origin 回显 + Allow-Headers + Allow-Methods），供 DSH GUI（:3080）调用 | `curl -H "Origin: http://localhost:3080" -i /api/dir` 响应含 ACAO 头 | 响应无 CORS 头，浏览器 fetch 被拦截 | genoffice relay | curl -i 实测 |
| BR-007 | 点击文件 → 侧边栏内嵌 iframe 打开 `http://localhost:8787/<app>/?open=path:<绝对路径>`（docx→docs，md→markdown）；iframe 只读（无写回） | 点击 `.docx` 文件，iframe 渲染出文档内容 | iframe 空白或加载错误提示 | GenOffice tab | browser 实测 + 截图 |
| BR-008 | 预览面板提供"在浏览器中打开"按钮：`window.open(同一 URL)` 新标签打开完整编辑器 | 点击按钮 → 新标签打开可编辑完整版 | 按钮缺失或打不开 | GenOffice tab | browser 实测 |
| BR-009 | 文件管理面板数据源为 DSH `host.listDirectory`（浏览器直连 host，无跨域问题）；支持路径导航（进入/上级/主目录） | 进入 `/tmp` 后列表刷新 | 列表为空且无错误提示 | 文件 tab | browser 实测 |
| BR-010 | 终端面板：xterm.js 渲染 + host `node-pty` shell 会话；输入输出双向实时；面板关闭/切换销毁会话（不留孤儿进程） | 终端输入 `echo hi` 回车 → 输出 `hi`；关闭 tab 后 `ps` 无残留 node-pty 子进程 | 输出不回显或关闭后进程残留 | 终端 tab + host 插件 | browser 实测 + `ps` 检查 |
| BR-011 | 预览模式不写回：iframe 内 Ctrl+S 触发下载新文件，原文件字节不变（对比打开前后 sha256） | 预览后原文件 hash 不变 | 原文件被修改 | GenOffice tab | 实测 sha256 对比 |

### 2.2 UF 用户验收场景（索引）

| 场景 ID | Given | When | Then | 角色 | 验证方式 | Evidence |
|---|---|---|---|---|---|---|
| UF-001 | 侧边栏可见，选项卡栏渲染 | 用户依次点击「工作区/终端/GenOffice/文件」 | 面板切换、激活态高亮、内容正确 | 用户 | browser | EVD-001 |
| UF-002 | GenOffice tab 激活，文件列表已加载 | 用户点击一个 `.docx`/`.md` 文件 | 侧边栏内嵌 iframe 渲染文档内容（只读） | 用户 | browser | EVD-002 |
| UF-003 | GenOffice 预览已打开 | 用户点击「在浏览器中打开」 | 新标签打开完整编辑器，原面板不受影响 | 用户 | browser | EVD-003 |
| UF-004 | 文件 tab 激活 | 用户浏览目录（进入/上级/主目录）并查看文件列表 | 目录切换即时刷新；当前路径可见 | 用户 | browser | EVD-004 |
| UF-005 | 终端 tab 激活 | 用户输入 shell 命令并回车 | 命令输出实时回显；Ctrl+C 可中断 | 用户 | browser | EVD-005 |
| UF-006 | 侧边栏处于展开态且激活 GenOffice tab | 用户折叠侧边栏再展开 | 恢复原激活 tab 与面板状态 | 用户 | browser | EVD-001 |

### 2.3 核心业务流程（步骤级交互脚本）

#### UF-001: 侧边栏选项卡切换

**前置状态**：DSH Web GUI 已加载（127.0.0.1:3080），侧边栏展开，选项卡栏含「工作区/终端/GenOffice/文件」

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 点击「GenOffice」tab | tab 高亮、面板区切换 loading（≤300ms） | 容器切换渲染 `sidebar.tabs.genoffice` 子槽位；GenOffice 面板挂载并请求文件列表 | 面板显示文件列表（加载态→列表） |
| 2 | 点击「文件」tab | tab 高亮切换 | 卸载 GenOffice 面板（或保持挂载按需），挂载文件面板，调用 `host.listDirectory` | 文件管理面板显示目录内容 |
| 3 | 依次切换全部 tab | 每步即时切换 | 各子槽位按需挂载/卸载 | 工作区/终端/文件/GenOffice 均可达 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 子槽位未注册 | 某 tab 无注册者（如终端插件加载失败） | 该 tab 隐藏或显示"不可用"，其余 tab 正常 | console 记录缺失槽位告警 | 用户切换其他 tab；日志定位插件 |
| 面板挂载异常 | 组件渲染抛错 | React 错误边界显示占位，不白屏 | console error 记录 | 刷新页面 |
| 折叠态切换 | 用户在 rail 折叠态点击 rail 图标 | 侧边栏展开并显示原激活 tab | 容器恢复 store 中的激活 tab | 无 |

**界面状态机**：

```text
[rail] ←折叠→ [展开 + 激活 tab T]
                 │ 点击 tab T' 
                 ▼
            [展开 + 激活 tab T']（原 T 状态保留）
```

**入口接线清单**（本流程从哪些真实入口可达；实现任务必须包含接线）：

- 侧边栏选项卡栏（容器组件渲染）→ 每个 tab 按钮 onClick → 切换激活状态 + 渲染对应子槽位
- 侧边栏折叠/展开（官方 DragHandle/rail 机制保留）→ 容器读取 layout 状态恢复激活 tab

#### UF-002: GenOffice 面板文件列表与预览

**前置状态**：GenOffice tab 激活，relay（:8787）运行中，文件列表已加载（默认主目录）

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 点击文件列表中的 `报告.docx` | 行高亮、预览区显示 loading | 面板以 `?open=path:<绝对路径>` 构造 iframe URL（`/docs/`）并挂载 iframe | iframe 渲染文档内容（只读） |
| 2 | 点击目录行 `../` 或文件夹 | 列表刷新 loading | 调用 `GET /api/dir?path=<新路径>` 替换列表 | 新目录内容；当前路径栏更新 |
| 3 | 点击「在浏览器中打开」 | 按钮无阻塞 | `window.open(iframe URL, '_blank')` | 新标签打开完整编辑器 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| relay 未启动 | :8787 无服务 | 列表区显示"中继服务未启动"提示 + 重试按钮 | fetch 失败被捕获 | 用户启动 `npm run web` 后点重试 |
| 路径不可读 | 文件被删/无权限 | 行点击后预览区显示错误提示 | `/api/file` 返回 ok:false | 用户选择其他文件 |
| 类型不支持 | 点击 `.xlsx` | 行禁用或提示"仅桌面版可用" | 前端按扩展名过滤 | 用户选择 docx/md |
| 空目录 | 目录无文件 | 列表显示"空目录"占位 | 正常返回空 entries | 用户返回上级 |

**界面状态机**：

```text
idle → loading(list) → list
         ↓ 点击文件
      preview-loading → preview(iframe)
         ↓ 失败
      error（保留列表，可重试/换文件）
```

**入口接线清单**：

- GenOffice tab 面板（`sidebar.tabs.genoffice` 子槽位）→ 文件列表行 onClick → 预览 iframe；目录行 onClick → 重新拉取列表
- 「在浏览器中打开」按钮 onClick → window.open

#### UF-003: 在浏览器中打开

**前置状态**：UF-002 预览已打开

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 点击「在浏览器中打开」 | 无 | 新标签 `window.open('/docs/?open=path:...')` | 新标签完整编辑器，可编辑（保存=下载） |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 弹窗拦截 | 浏览器拦截 window.open | 面板内提示"请允许弹窗" | 无 | 用户放行后重试 |

**界面状态机**：`idle → opened(新标签)`（面板保持不动）

**入口接线清单**：预览工具栏按钮 onClick。

#### UF-004: 文件管理目录浏览

**前置状态**：文件 tab 激活，DSH host 运行中

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 点击文件夹 `projects` | 列表刷新 loading | `ctx.connection.api.host.listDirectory('/xxx/projects')` | 子目录与文件列表 |
| 2 | 点击 `..`（上级） | 列表刷新 | listDirectory(上级路径) | 上级目录内容 |
| 3 | 点击主目录按钮 | 列表刷新 | listDirectory(undefined) | 主目录内容 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| 权限/路径错误 | 目录不可读 | 错误提示行，列表保留上次 | RpcResponse 非 ok | 用户回退路径 |
| host 断连 | DSH 重启 | 面板显示"连接已断开" | api 调用 reject | 重连后自动恢复 |

**界面状态机**：`idle → loading → list | error（保留上次列表）`

**入口接线清单**：文件 tab 面板行 onClick（目录进入/上级）、主目录按钮。

#### UF-005: 终端面板执行命令

**前置状态**：终端 tab 激活，host 侧 pty 插件已加载

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 面板挂载 | 终端渲染提示符 | client 建立 ws 连接 `/api/pty.ws`，host spawn shell（cwd=用户主目录） | xterm 显示 shell 提示符 |
| 2 | 输入 `echo hello` 回车 | 输入回显 | 输入经 ws 转发 → pty write；输出经 ws → xterm | 输出 `hello` |
| 3 | 输入 `exit` | 会话结束 | pty 销毁，ws 关闭 | 终端显示进程结束，面板可重建 |

**失败分支**：

| 分支 | 触发条件 | 界面表现 | 系统行为 | 恢复路径 |
|---|---|---|---|---|
| ws 连接失败 | host 插件未加载/端口不通 | 终端显示"连接失败" + 重连按钮 | 无会话创建 | 重试 |
| 面板切换 | 用户切到其他 tab | 会话销毁（BR-010） | host 关闭 pty | 切回终端 tab 重建会话 |

**界面状态机**：`disconnected → connecting → connected(pty) → closed`（切 tab 即销毁重建）

**入口接线清单**：终端 tab 面板挂载时建 ws 会话；卸载时关闭；xterm onData → ws send。

#### UF-006: 折叠恢复

**前置状态**：侧边栏展开，激活 GenOffice tab

**成功主路径**：

| 步骤 | 用户动作 | 界面即时反馈 | 系统行为 | 用户看到的结果 |
|---|---|---|---|---|
| 1 | 折叠侧边栏（rail 态） | rail 图标保留 | 容器记录激活 tab 到内存 store | rail 显示 tab 图标（或容器图标） |
| 2 | 展开侧边栏 | 面板恢复 | 容器按 store 恢复激活 tab | GenOffice 面板原样恢复 |

**失败分支**：折叠期间切换会话（DSH 会话级状态）→ 面板按新会话重新挂载（ASM-003 注明）。

**界面状态机**：`expanded(T) ⇄ collapsed`（T 持久于内存 store）

**入口接线清单**：容器组件订阅 layout 折叠状态；rail 渲染 tab 图标按钮。

### 2.4 INV 不变量

| 不变量 ID | 内容 | 关联 BR/UF | 验证方式 |
|---|---|---|---|
| INV-001 | 官方工作区列表（`sidebar.workspaces`）与设置（`sidebar.settings`）功能不回归：会话创建/切换/搜索与设置入口仍可用 | BR-001/BR-002, UF-001 | 5.2 实测：创建会话、切换会话、打开设置 |
| INV-002 | genoffice relay 既有 API（health/search/fetch-file/file/inject 等）响应结构不变，向后兼容 | BR-004~BR-006 | 回归：`node web/e2e-url-open.mjs` + curl 既有端点 |
| INV-003 | `path:`/`server:`/`inject:` 安全边界不放松：loopback 默认策略不变；网络暴露必须显式开关 | BR-005 | curl 双配置实测（同 1.3 事实） |
| INV-004 | DSH 官方包零源码修改：全部改动经 profile patch / 插件包实现 | 全部 | git status 检查 worktree 无官方包改动 |
| INV-005 | genoffice 网页版现有功能（主页/docs/markdown/拖拽/URL 打开）不回归 | BR-007/BR-011 | 回归：`web/` 下 5 个 e2e 脚本全绿 |
| INV-006 | 终端会话无泄漏：面板卸载/页面关闭后 host 无残留 node-pty 子进程 | BR-010, UF-005 | `ps aux | grep <shell>` 实测 |

### 2.5 EVD 证据清单

| 证据 ID | 类型 | 期望证据 | 保存位置 |
|---|---|---|---|
| EVD-001 | screenshot | 侧边栏选项卡栏 + 各 tab 面板截图（含 rail 折叠态） | `evidence/UF-001/` |
| EVD-002 | screenshot | GenOffice 预览 iframe 渲染文档截图 | `evidence/UF-002/` |
| EVD-003 | screenshot | 新标签完整编辑器截图 | `evidence/UF-003/` |
| EVD-004 | screenshot | 文件管理目录浏览截图 | `evidence/UF-004/` |
| EVD-005 | screenshot | 终端执行 `echo` 输出截图 | `evidence/UF-005/` |
| EVD-006 | log | `/api/dir` curl 输出样例 | `evidence/API-dir/` |
| EVD-007 | log | CORS 响应头 curl -i 样例 | `evidence/API-cors/` |
| EVD-008 | log | 冒烟插件加载日志（DSH console） | `evidence/phase-0/` |
| EVD-009 | log | DSH GUI console 无错误日志（各 UF 执行时收集） | `evidence/UF-xxx/console.log` |

### 2.6 角色与权限矩阵

| 角色 | 可见 | 可操作 | 禁止 | 失败提示 | 验证场景 |
|---|---|---|---|---|---|
| 本机 DSH 用户（loopback） | 全部面板与文件 | 切换 tab / 浏览文件 / 预览 / 打开浏览器 / 终端命令 | 网络暴露时无开关不允许任意路径读取（relay 侧） | relay 错误提示/终端连接失败提示 | UF-001~UF-006 |

> 单一角色，无权限差异（本机工具）；relay 安全边界由 BR-005 覆盖。

### 2.7 负向 / 破坏性场景

| 场景 | Given | When | Then | Evidence |
|---|---|---|---|---|
| relay 未启动 | GenOffice tab 激活 | 点击文件/刷新列表 | 列表显示"中继服务未启动"+ 重试，无白屏 | EVD-002（错误态截图） |
| 路径越权（网络暴露） | `HOST=0.0.0.0` 且无 `GENOFFICE_WEB_OPEN_PATHS=1` | curl `/api/file?path=/etc/passwd` | 返回禁用错误 | EVD-007 |
| 终端孤儿进程 | 终端会话运行中 | 关闭 tab/页面 | host pty 销毁，`ps` 无残留 | EVD-005 + `ps` |
| 旧数据兼容 | 已装旧版 DSH（无本插件） | 升级加载插件 | 官方侧边栏行为完全保留（patch 可回退） | EVD-001（回退验证） |
| 预览写回 | iframe 预览中按 Ctrl+S | 触发下载新文件 | 原文件 sha256 不变 | EVD-002 + hash |

### 2.8 非目标

- 不做 GenOffice 侧边栏内编辑写回（用户确认后期再考虑）
- 不做多用户/远程部署的侧边栏（本机 loopback 场景）
- 不修改 DSH 官方包源码（INV-004）
- 不做终端主题配置/多会话管理（MVP 单会话）
- 不移植 sheets/slides/pdf 到 web（沿用现有"仅桌面版"提示）

---

## 3. 技术方案

### 3.1 架构 Before / After

```text
Before:
DSH Web GUI (:3080)
└── sidebar slot ── ui-sidebar (SidebarRoot)
    ├── sidebar.workspaces ── ui-workspace (WorkspaceBrowser)
    └── sidebar.settings ── ui-settings
         (单面板，无选项卡)

genoffice relay (:8787) ── 无 CORS、无列目录

After:
DSH Web GUI (:3080)
└── sidebar slot ── dsh-genoffice-sidebar (TabsRoot)   ← 本插件替换注册者
    ├── 选项卡栏: [工作区|终端|GenOffice|文件]
    ├── sidebar.workspaces（官方保留，工作区 tab 内）
    ├── sidebar.settings（官方保留）
    └── sidebar.tabs.<name>（可插拔子槽位）
        ├── sidebar.tabs.terminal ── xterm.js ⇄ ws → host pty 插件(node-pty)
        ├── sidebar.tabs.genoffice ── 文件列表(relay /api/dir) + iframe 预览
        └── sidebar.tabs.files ── host.listDirectory 目录浏览

genoffice relay (:8787) ── + CORS(loopback origin) + /api/dir
```

### 3.2 模块改造

| 模块 | 职责 | 改造说明 |
|---|---|---|
| genoffice `web/server.mjs` | 静态托管 + 中继 API | 新增 `GET /api/dir?path=`（列目录，安全策略同 /api/file）；统一 CORS 头（loopback Origin 白名单） |
| genoffice 各 app web-bridge | URL 打开 | 无改动（`path:` 已支持）；如引入只读参数则 docs 桥解析 `?view=`（P1 决定，默认不做） |
| DSH 插件包 `dsh-plugin/`（genoffice 仓库） | 侧边栏生态 | 新包：client 侧（TabsRoot + 三面板）+ host 侧（pty ws 端点） |
| DSH profile `~/.dsh/profiles/web` | 加载层 | cordis.patch.yml：disable `ui-sidebar` + insert 本插件；package.json 链接本地包 |

### 3.3 三段式定位清单

| 文件 | 稳定定位 | 搜索定位 | 行号 hint | 备注 |
|---|---|---|---|---|
| `web/server.mjs` | `handleApi` / `server.listen` | `rg "handleApi" web/server.mjs` | L~185/L~370 | 加 /api/dir + CORS；事实勘察过 |
| `apps/docs/src/renderer/web-bridge.ts` | `parseOpenTarget` / `bytesFromRemote` | `rg "parseOpenTarget" apps/docs/src/renderer/web-bridge.ts` | L~1000/L~1020 | 只读参数接线候选（P1 决定） |
| `.dsh-plugin-dev/packages/client/ui-sidebar/src/client/index.ts` | `apply(ctx)` / `ctx.slots.register` | `rg "name: 'sidebar'" .dsh-plugin-dev/packages/client/ui-sidebar/src/client/index.ts` | L38-L39 | 被替换的官方注册者（参考其 children/inject 形状） |
| `.dsh-plugin-dev/packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | `renderSlot` / `SidebarRoot` | `rg "renderSlot" .dsh-plugin-dev/packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | L174/L182 | 子槽位渲染参考（rail/collapsed props） |
| `.dsh-plugin-dev/packages/client/ui-layout/src/client/index.ts` | `LayoutService` / children 声明 | `rg "'details'" .dsh-plugin-dev/packages/client/ui-layout/src/client/index.ts` | L43/L85 | 槽位几何 owner props（collapsed/width） |
| `.dsh-plugin-dev/packages/client/ui-workspace/src/client/index.ts` | `ctx.slots.inject` / WorkspaceBrowser | `rg "slots.inject" .dsh-plugin-dev/packages/client/ui-workspace/src/client/index.ts` | L107 | 第三方注册标准模式（本插件照此） |
| `.dsh-plugin-dev/packages/client/ui-slots/src/index.ts` | `register` / `inject` 服务与 `SlotMap` 合并机制 | `rg "register" .dsh-plugin-dev/packages/client/ui-slots/src/index.ts` | L115/L240 | slots 服务 API 全貌（P2 读） |
| `.dsh-plugin-dev/packages/client/connection/src/client/fixture.ts` | `listDirectory` fixture 实现（参考其返回形状） | `rg "listDirectory" .dsh-plugin-dev/packages/client/connection/src/client/fixture.ts` | L2082 | 文件 tab 数据源返回形状 |
| `.dsh-plugin-dev/packages/pty/pty/src/types.ts` | `PtySpawnRequest` / `PtySendRequest` | `rg "PtySpawnRequest" .dsh-plugin-dev/packages/pty/pty/src/types.ts` | L40-L58 | spawn 请求形状：{type, name?, cwd?} |
| `.dsh-plugin-dev/packages/pty/pty/src/index.ts` | `PtyService` / `spawn` / `registerBackend` | `rg "async spawn" .dsh-plugin-dev/packages/pty/pty/src/index.ts` | L154/L105/L125 | host 终端服务：backend 注册表 + spawn(owner, request) |
| `.dsh-plugin-dev/packages/pty/pty-local/src/index.ts` | `apply(ctx, config)` / node-pty spawn | `rg "nodePty\|export function apply" .dsh-plugin-dev/packages/pty/pty-local/src/index.ts` | L8/L130 | node-pty backend 参考实现（P5 复用） |
| `~/.dsh/profiles/web/cordis.patch.yml` | `- insert:` / `- id:` | `rg "insert" ~/.dsh/profiles/web/cordis.patch.yml` | L~18 | disable ui-sidebar + insert 插件 |
| `~/.dsh/profiles/web/package.json` | `dsh.profile.bundles` | `rg "bundles" ~/.dsh/profiles/web/package.json` | L~10 | 加本地插件依赖（ASM-001） |
| `.dsh-plugin-dev/apps/cli/src/profile-boot.ts` | `dsh web --profile` 加载栈 | `rg "cordis.patch.yml" .dsh-plugin-dev/apps/cli/src/profile-boot.ts` | L2-L6 | bundle 层序 + patch 层序 + --patch 覆盖 |

### 3.4 API / 数据 / 权限 / 路由影响

| 类型 | 是否影响 | 说明 | 兼容策略 |
|---|---|---|---|
| API | 是（genoffice relay 增量） | 新增 `GET /api/dir`；既有 API 全部不动 | 只增不改，向后兼容 |
| API | 是（新增 CORS 头） | relay 响应统一加 loopback Origin 白名单 CORS | 无 Origin 请求（同源）行为不变 |
| 数据 | 否 | 无持久化数据格式变化；插件状态为内存态 | — |
| 权限 | 是（relay 侧） | `/api/dir` 沿用 `/api/file` 安全策略 | 与 BR-005 一致，网络暴露需开关 |
| 路由 | 否（genoffice）；是（DSH GUI 侧边栏） | DSH 侧边栏注册者替换 | patch 层可回退（disable 本插件即还原官方） |

---

## 4. Phase 计划与任务详情

> Phase 依赖链：

```text
P0 基线与勘察 → P1 relay 配套 → P2 插件骨架 → P3 GenOffice tab → P4 文件 tab → P5 终端 tab → P6 集成验收
```

> 任务状态跟踪：任务数 ≥ 8，用同目录 `tasks.csv`（Stage 2 生成）。
> 任务标题必须是 `### Task {N}: {标题}` 格式（Stage 2 展开）。

### Phase 0: 基线与勘察（P0 草案）

> 你在哪里：worktree 已建、机制已勘察（§1.3）
> 做完之后：插件加载链路跑通（冒烟面板出现）、iframe 嵌入实测可行、本地插件包安装方式确定

草案任务（Stage 2 展开详情）：

1. 冒烟插件：最小 client 插件包（注册测试 tab 到 sidebar）+ profile patch 加载 + `dsh web` 重启实测出现 → 确认 ASM-001/ASM-002
2. 勘察确认：`ui-slots` register API 全貌、`ui-workspace` inject 形状、profile-boot 启动方式、pty spawn 字段（P5 前置勘察可并入）
3. 基线回归：genoffice 现有 e2e 全绿 + DSH web 现状截图 → 记录基线

### Phase 1: genoffice relay 配套（P0 草案）

> 做完之后：`/api/dir` 可用、跨域可调、既有 API 不回归

草案任务：

4. 实现 `GET /api/dir?path=`（列目录：entries[name/dir/size/mtime/ext] + 当前路径 + 上级路径；安全策略同 /api/file）
5. 实现 relay CORS 中间层（loopback Origin 白名单回显 + Allow-Headers/Methods + 预检 OPTIONS）
6. relay 回归：curl 全端点 + `node web/e2e-url-open.mjs` 全绿

### Phase 2: 插件骨架（P0 草案）

> 做完之后：侧边栏出现选项卡容器，官方工作区/设置面板在容器内可用，rail 折叠恢复正常

草案任务：

7. 搭建 `dsh-plugin/` 包结构（client 入口 + 构建配置 + 类型引用 worktree 包）
8. 实现 TabsRoot 容器（替换 sidebar 注册：patch disable ui-sidebar；渲染选项卡栏 + sidebar.workspaces/sidebar.settings 子槽位 + sidebar.tabs.* 子槽位 + rail 态）
9. 激活 tab 内存 store + 折叠恢复（BR-003）+ 子槽位未注册降级（UF-001 失败分支）
10. 工作区/设置回归验证（INV-001）

### Phase 3: GenOffice tab（P0 草案）

> 做完之后：文件列表 + iframe 预览 + 浏览器打开（BR-004~BR-008/BR-011）

草案任务：

11. GenOffice 面板：文件列表（relay /api/dir，默认主目录、目录导航、类型过滤、错误态/重试）
12. iframe 预览（构造 path: URL、加载态、错误态）+ 只读确认（BR-011）
13. "在浏览器中打开"按钮（BR-008）

### Phase 4: 文件 tab（P0 草案）

> 做完之后：host.listDirectory 目录浏览（BR-009, UF-004）

草案任务：

14. 文件面板：listDirectory 数据源 + 路径导航 + 错误态（UF-004 全分支）

### Phase 5: 终端 tab（P0 草案）

> 做完之后：xterm + pty ws 双向实时、会话生命周期（BR-010, UF-005）

草案任务：

15. host 侧 pty 插件（node-pty spawn + `/api/pty.ws` WebSocket，cwd=主目录；会话注册表与销毁）
16. client 终端面板（xterm.js 渲染、ws 连接、重连、卸载销毁）

### Phase 6: 集成验收（P0 草案）

> 做完之后：profile 加载完整插件、5.2 真实场景全套通过、回归全绿

草案任务：

17. profile 集成（patch disable ui-sidebar + insert 全部面板；本地包安装确认）
18. 执行 spec 5.2 真实场景全套测试（UF-001~UF-006 主路径+失败分支）
19. 全量回归（INV-001~INV-006）+ evidence 归档 + 状态板收尾

---

## 5. 验收与 Review 协议

> Stage 2 展开：5.1 命令级验证表 / 5.2 真实场景执行矩阵（环境准备：`dsh web` 启动 + Playwright + curl）/ 5.3 evidence 结构 / 5.4 专项检查清单。

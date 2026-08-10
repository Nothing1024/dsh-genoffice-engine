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

> 任务状态跟踪：任务数 ≥ 8，用同目录 `tasks.csv`（纯状态板，8 列）。

### Phase 0: 基线与勘察

> 你在哪里：worktree 已建（`genoffice/.dsh-plugin-dev` @ c15895f，分支 `genoffice-web-plugin`）；机制已勘察（§1.3 全部为实测事实）
> 做完之后：插件加载链路跑通（冒烟面板出现）、iframe 嵌入实测可行、本地插件包安装方式确定、genoffice 基线回归全绿

### Task 1: 搭建冒烟插件包并验证 DSH 加载链路

- **关联**：BR-001 / INV-004 / EVD-008（UF: NA——内部验证任务，不直接面向用户）
- **前置任务**：无
- **风险等级**：P0（ASM-001/ASM-002 的验证点，失败则阻塞 P2）

**为什么做**：本地插件包能否被 DSH client boot 加载（ASM-001）与 iframe 能否嵌入（ASM-002）是整个方案的地基，必须先以小代价验证。

**涉及文件与定位**：

- `genoffice/dsh-plugin/`（新建）：最小 client 插件包（package.json + apply(ctx) 注册 `sidebar.tabs.smoke` 测试面板）
- `.dsh-plugin-dev/packages/client/ui-workspace/src/client/index.ts`：`ctx.slots.inject('sidebar.workspaces', ...)`，`rg "slots.inject"`，L107（注册模式模板）
- `~/.dsh/profiles/web/cordis.patch.yml`：`- insert:` 列表，`rg "insert"`，L~18（插件装载点）
- `~/.dsh/profiles/web/package.json`：`dsh.profile.bundles`，`rg "bundles"`，L~10（依赖链接点）
- `/Users/nothing/workspace/dsh/test-Nothing1024/bin/dsh`：CLI 入口（`dsh web` 启动 DSH Web GUI）

**具体操作**：

1. 在 `genoffice/dsh-plugin/` 建最小包：`package.json`（name `dsh-genoffice-sidebar`，client 入口 `apply(ctx)`，`ctx.slots.register({name:'sidebar.tabs.smoke',...}, <SmokePanel>)` 注册测试面板）+ TS 源文件
2. 在 `~/.dsh/profiles/web/package.json` 加依赖 `"dsh-genoffice-sidebar": "file:/Users/nothing/workspace/dsh/genoffice/dsh-plugin"`，执行 `cd ~/.dsh/profiles/web && pnpm install`（nodeLinker: hoisted）
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 的 insert 列表加 `- id: genoffice-smoke` / `name: 'dsh-genoffice-sidebar'`（参照 ui-layout 行的 id/name 形状）
4. 重启 DSH Web GUI：`/Users/nothing/workspace/dsh/test-Nothing1024/bin/dsh web`，浏览器打开 http://127.0.0.1:3080，F12 console 检查插件加载日志（EVD-008）
5. 若插件未加载：检查 patch 语法、包解析（`node -e "require.resolve('dsh-genoffice-sidebar', {paths:['<profiles/web>']})"`）、bootHost 对 client 插件的扫描规则（`rg "dshClient|__DSH_BOOT__" .dsh-plugin-dev/packages/client/web/src`）——记录根因回写 §1.3
6. iframe 实测：在 DSH GUI 页面 F12 执行 `document.body.insertAdjacentHTML('beforeend','<iframe src="http://localhost:8787/docs/"/>')`，确认渲染无 CSP 拦截（验证 ASM-002）

**验证**：`dsh web` 启动后 console 出现冒烟插件日志/面板可见 → 期望加载成功；iframe 注入后可见 docs 页面 → 期望无 frame 拦截

**Evidence**：`evidence/phase-0/smoke-console.log` + `evidence/phase-0/iframe.png`

**注意事项**：易错点——patch 的 id 与 name 必须与既有行同构、`file:` 依赖路径必须绝对；禁止修改 DSH 官方包源码（INV-004）

### Task 2: 建立 genoffice 基线回归快照

- **关联**：INV-002 / INV-005 / EVD-009（UF: NA——基线任务）
- **前置任务**：无
- **风险等级**：P2

**为什么做**：后续 Phase 改动 relay 与桥后，需要与基线对比证明无回归。

**涉及文件与定位**：

- `genoffice/web/*.mjs`：6 个 e2e 脚本（`smoke-test` / `e2e-open-save` / `e2e-home` / `e2e-cross-app` / `e2e-dragdrop` / `e2e-url-open`）

**具体操作**：

1. 确认 relay 运行：`curl http://localhost:8787/api/health`
2. 依次运行 `node web/smoke-test.mjs`、`node web/e2e-open-save.mjs`、`node web/e2e-home.mjs`、`node web/e2e-cross-app.mjs`、`node web/e2e-dragdrop.mjs`、`node web/e2e-url-open.mjs`，全部期望全绿
3. 记录每个脚本输出摘要到 `evidence/phase-0/baseline.log`

**验证**：6 个脚本全部通过且无 console error → 期望与 §1.3 事实一致

**Evidence**：`evidence/phase-0/baseline.log`

**注意事项**：DuckDuckGo 搜索可能被限流（已有 Bing 备选自动切换），失败时重试即可

### Task 3: 执行 Phase 0 回归验证

- **关联**：本 Phase 全部 BR/UF/INV（冒烟链路 + 基线）
- **前置任务**：1;2
- **风险等级**：P1

**验证**：`dsh web` 正常启动且冒烟面板可见 + `node web/e2e-url-open.mjs` 全绿 + console 无新增 error

**Evidence**：`evidence/phase-0/`

### Phase 1: genoffice relay 配套

> 你在哪里：relay 无 CORS、无列目录 API
> 做完之后：`/api/dir` 可用（安全策略同 `/api/file`）、loopback 跨域可调、既有 API 全绿

### Task 4: 实现 relay 列目录 API /api/dir

- **关联**：BR-004 / BR-005 / UF-002 / EVD-006（UF-002 的前置数据源）
- **前置任务**：2
- **风险等级**：P1

**为什么做**：GenOffice 面板文件列表需要按路径列目录的数据源。

**涉及文件与定位**：

- `genoffice/web/server.mjs`：`handleApi`，`rg "handleApi"`，L204（API 注册点，紧跟 `/api/file` 分支之后加新分支）
- `genoffice/web/server.mjs`：`FILES_ROOT` / `ALLOW_ABS_PATHS`，`rg "ALLOW_ABS_PATHS"`，L~25（复用安全策略判定）

**具体操作**：

1. 在 `handleApi` 中新增 `GET /api/dir?path=` 分支：
   - `path` 缺省 = 用户主目录（`os.homedir()`）；`resolve()` 成绝对路径
   - `ALLOW_ABS_PATHS` 为 false 时返回与 `/api/file` 一致的禁用错误
   - `readdir(path, {withFileTypes:true})` 列条目，返回 `{ ok, path, parent, entries: [{name, dir, size, mtimeMs, ext}] }`（ext 仅文件有；`..` 由前端拼接 parent）
   - 排序：目录在前，按名称 localeCompare；隐藏文件（`.` 开头）排在最后
   - 目录不可读/不存在 → `{ ok:false, error }`（不抛 500）
2. 更新文件头注释的 API 清单

**验证**：`curl "http://localhost:8787/api/dir?path=/tmp"` → 期望 `{ok:true, entries:[...]}`；`curl "http://localhost:8787/api/dir?path=/nonexistent"` → 期望 `{ok:false}`；`HOST=0.0.0.0` 且无开关 → 期望禁用错误

**Evidence**：`evidence/API-dir/dir-tmp.json` + `evidence/API-dir/dir-missing.json`

**注意事项**：禁止返回符号链接指向目录外的内容（`dirent.isSymbolicLink()` 标记即可，不追链）；禁止吞掉权限错误不提示

### Task 5: 实现 relay CORS（loopback Origin 白名单）

- **关联**：BR-006 / UF-002 / EVD-007
- **前置任务**：4
- **风险等级**：P1

**为什么做**：DSH GUI（http://127.0.0.1:3080）与 relay（http://localhost:8787）跨源，浏览器 fetch 需要 CORS 头；仅放行 loopback 来源，不放宽任意站点。

**涉及文件与定位**：

- `genoffice/web/server.mjs`：`createServer` 回调，`rg "createServer"`，L~385（统一响应头入口）

**具体操作**：

1. 定义 loopback Origin 白名单判定：`/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/`
2. 在 `createServer` 回调中对**所有**响应统一注入：
   - 若请求头 `Origin` 命中白名单 → `Access-Control-Allow-Origin: <回显 Origin>`、`Access-Control-Allow-Headers: Content-Type, X-File-Name`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`
   - `OPTIONS` 预检请求 → 直接 204 返回（带上述头）
   - 非白名单 Origin → 不加 CORS 头（同源行为不变）
3. 无 `Origin` 请求（同源/curl）→ 不加头，保持现状

**验证**：`curl -i -H "Origin: http://127.0.0.1:3080" http://localhost:8787/api/health` → 期望响应含 `Access-Control-Allow-Origin: http://127.0.0.1:3080`；`curl -i -H "Origin: https://evil.com" ...` → 期望无 CORS 头

**Evidence**：`evidence/API-cors/cors-loopback.txt` + `evidence/API-cors/cors-foreign.txt`

**注意事项**：禁止用 `*` 通配；禁止对非白名单来源回显 Origin

### Task 6: relay 配套回归

- **关联**：INV-002 / INV-003 / EVD-006 / EVD-007
- **前置任务**：4;5
- **风险等级**：P1

**验证**：`node web/e2e-url-open.mjs` 全绿 + `curl` 既有端点（health/fetch-file/file/inject 各一发）结构不变 + 新端点双配置（loopback 默认 / HOST=0.0.0.0 无开关）行为符合 BR-005

**Evidence**：`evidence/API-dir/regression.log`

**注意事项**：验证 `/api/file` 的禁用分支仍为原错误文案（INV-003 不允许文案漂移）

### Task 7: 执行 Phase 1 回归验证

- **关联**：本 Phase 全部 BR/INV
- **前置任务**：6
- **风险等级**：P2

**验证**：Task 6 全绿 + `curl /api/dir` 三态（正常/缺失/禁用）复跑一致

**Evidence**：`evidence/phase-1/`

### Phase 2: 插件骨架（TabsRoot 选项卡容器）

> 你在哪里：冒烟插件可加载；侧边栏仍为官方单面板
> 做完之后：侧边栏出现选项卡栏（工作区/终端/GenOffice/文件），官方工作区/设置面板在容器内可用，rail 折叠恢复正常，激活 tab 记忆

### Task 8: 搭建 dsh-plugin 正式包结构

- **关联**：BR-002 / INV-004 / EVD-008（UF: NA——工程任务）
- **前置任务**：1
- **风险等级**：P1

**为什么做**：从冒烟包演进为正式 client 插件包，承载 TabsRoot 与三个面板。

**涉及文件与定位**：

- `genoffice/dsh-plugin/`（Task 1 已建）：package.json / tsconfig / src 结构
- `.dsh-plugin-dev/packages/client/ui-slots/src/index.ts`：`register` / `SlotMap` 合并，`rg "register"`，L115/L240（注册契约）
- `.dsh-plugin-dev/packages/client/ui-sidebar/src/client/index.ts`：`apply` / `inject`，`rg "inject"`，L38-L39（官方注册形状参考）

**具体操作**：

1. 规范包结构：`src/index.ts`（`apply(ctx)` + `inject: ['slots','layout','sessions','workspaces','locale']` 按需声明）、`src/TabsRoot.tsx`、`src/store.ts`、`src/tabs/{workspace,terminal,genoffice,files}.tsx`（占位）、`README.md`
2. 构建：参考 `ui-sidebar` 的 `tsdown.config.ts` 输出 client 可加载产物；typecheck 命令进 package.json scripts
3. 确认 `ctx.slots.register` 的完整签名（children 声明、inject hook、store seat）并记录到 README（P2 实现依赖）

**验证**：`cd dsh-plugin && npm run typecheck` 通过 + `npm run build` 产物可被 client 加载（沿用 Task 1 冒烟验证路径）

**Evidence**：`evidence/phase-2/build.log`

**注意事项**：禁止把官方包的内部类型当公共 API 用（以 packages/client 各包 `/client` 导出面为准）；DSH 包版本演进风险记录到 README

### Task 9: 实现 TabsRoot 选项卡容器并替换 sidebar 注册者

- **关联**：BR-001 / BR-002 / BR-003 / UF-001 / UF-006 / INV-001 / EVD-001（核心任务）
- **前置任务**：8
- **风险等级**：P0

**为什么做**：统一生态的骨架——选项卡栏 + 可插拔子槽位 + 官方面板保留。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/TabsRoot.tsx`（新建）：容器组件
- `.dsh-plugin-dev/packages/client/ui-sidebar/src/client/SidebarRoot.tsx`：`renderSlot('sidebar.workspaces')` / `renderSlot('sidebar.settings')`，L174/L182（子槽位渲染参考与 props 形状）
- `.dsh-plugin-dev/packages/client/ui-sidebar/src/client/index.ts`：`name: 'sidebar'`，L39（被替换的注册者；patch disable 的对象）
- `~/.dsh/profiles/web/cordis.patch.yml`：insert 列表（装载点）
- `genoffice/dsh-plugin/src/index.ts`：`ctx.slots.register({name:'sidebar', children:{...}, ...}, TabsRoot)`（注册点）

**具体操作**：

1. `TabsRoot` 组件：
   - 顶部选项卡栏：`工作区 | 终端 | GenOffice | 文件`（激活态高亮；图标用文本+简单 SVG，样式对齐官方 rail 风格）
   - 内容区按激活 tab 渲染：工作区 → `renderSlot('sidebar.workspaces', props)`；设置保留在 rail 底部入口（`renderSlot('sidebar.settings', {wide})`）；其余 → `renderSlot('sidebar.tabs.<name>')`
   - 折叠态（`collapsed` owner prop）：渲染 rail 图标列（tab 图标可点击直接激活对应 tab 并展开）
2. `index.ts` 注册：`children` 声明 `sidebar.tabs`（容器级）+ 三个 tab 子槽位（`sidebar.tabs.terminal/genoffice/files`，kind single, scope root）——子槽位由后续 Task 注册，本 Task 先声明（未注册时按 UF-001 失败分支降级隐藏 tab）
3. patch 配置：`cordis.patch.yml` 增加 `- id: ui-sidebar` + `disabled: true`（官方行）+ insert 本插件行（`name: 'dsh-genoffice-sidebar'`）
4. 重启 `dsh web` 实测：选项卡栏出现；工作区 tab 内官方会话列表可用；设置入口可用

**验证**：`dsh web` 后侧边栏显示选项卡栏，点击各 tab 无 console error；官方工作区列表可见可点（INV-001 初步）

**Evidence**：`evidence/UF-001/tabs-bar.png` + `evidence/phase-2/tabs-console.log`

**注意事项**：禁止改动官方 `ui-sidebar` 源码（INV-004）；patch disable 后若 rail 样式缺失，参考 `SidebarRoot.module.css` 自绘（ASM-003）；子槽位未注册时 tab 必须隐藏而非渲染空白

### Task 10: 实现激活 tab store 与折叠恢复

- **关联**：BR-003 / UF-006 / EVD-001
- **前置任务**：9
- **风险等级**：P2

**为什么做**：折叠/展开后恢复原 tab（BR-003），并处理会话切换等边界。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/store.ts`（新建）：`createTabsStore`（激活 tab、每 tab 状态保留位）
- `.dsh-plugin-dev/packages/client/ui-layout/src/client/stores.ts`：布局 store（参考其 transient store 形状，`rg "createLayoutStore"`）

**具体操作**：

1. store：`{ active: TabId, byTab: Record<TabId, unknown> }`，`setActive` / `patchTab` actions；参照 `ui-layout` 的 store 模式（transient，不写 localStorage——与官方一致，刷新回默认）
2. TabsRoot 订阅 `layout` 折叠状态：折叠时记录 active，展开时恢复
3. 错误边界：单个 tab 渲染抛错 → 占位 + console 记录，不白屏（UF-001 失败分支）

**验证**：browser 实测：切 GenOffice → 折叠 → 展开 → 仍为 GenOffice；渲染抛错模拟（临时 throw）→ 占位出现

**Evidence**：`evidence/UF-006/collapse-restore.png`

**注意事项**：store 状态不许写 localStorage（与官方布局策略一致，ASM-003 注明刷新回默认）

### Task 11: 执行 Phase 2 回归验证

- **关联**：INV-001 / UF-001 / UF-006 全分支
- **前置任务**：9;10
- **风险等级**：P1

**验证**：官方工作区会话创建/切换/搜索 + 设置入口逐项可用；四个 tab 可达（终端/GenOffice/文件显示占位或隐藏）；rail 折叠展开恢复；console 无 error

**Evidence**：`evidence/phase-2/`

### Phase 3: GenOffice tab

> 你在哪里：选项卡容器就绪，GenOffice tab 占位
> 做完之后：文件列表（relay /api/dir）+ iframe 只读预览 + 浏览器打开（BR-004~BR-008/BR-011）

### Task 12: 实现 GenOffice 文件列表面板

- **关联**：BR-004 / BR-005 / UF-002 / EVD-002 / EVD-006
- **前置任务**：7;11
- **风险等级**：P0

**为什么做**：GenOffice 面板的文件浏览器（自带文件浏览器需求）。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/tabs/genoffice.tsx`（新建）：面板组件
- `genoffice/web/server.mjs`：`/api/dir`（Task 4 产出，数据源）

**具体操作**：

1. 组件状态机：`idle/loading/list/error`（对应 UF-002 状态机）
2. 初始路径 = 主目录（`/api/dir` 缺省）；顶部当前路径栏 + 上级（`..`）按钮；目录行点击进入；文件行按扩展名分类展示（docx/md 可点击，其他置灰并提示"仅桌面版可用"）；空目录占位；错误态显示"中继服务未启动/路径不可读" + 重试按钮（UF-002 失败分支）
3. 数据获取：`fetch('http://localhost:8787/api/dir?path=' + encodeURIComponent(p))`（CORS 由 Task 5 保证）；失败捕获进 error 态
4. 选中文件后调用 `onPreview(path, name)`（由 Task 13 接线）
5. 文件类型过滤：仅 docx/md 可预览（BR-007）

**验证**：browser 实测：列表加载主目录 → 进入子目录 → 上级返回；点击 .docx 触发预览回调；点击 .xlsx 提示"仅桌面版可用"；relay 停掉后错误态 + 重试恢复

**Evidence**：`evidence/UF-002/list.png` + `evidence/UF-002/list-error.png`

**注意事项**：禁止直接拼 iframe URL 而不经过 Task 13 的预览控制器；路径一律 encodeURIComponent；隐藏文件默认不显示（与 relay 排序一致）

### Task 13: 实现 iframe 预览（只读）

- **关联**：BR-007 / BR-011 / UF-002 / EVD-002
- **前置任务**：12
- **风险等级**：P0

**为什么做**：侧边栏内嵌打开 GenOffice 预览（用户确认：嵌入；只读）。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/tabs/genoffice.tsx`：预览区（列表下方或切换视图）
- `genoffice/apps/docs/src/renderer/web-bridge.ts`：`parseOpenTarget` / `openTarget`（`path:` 目标由 relay 读取，`rg "isPath"`，L1028——预览复用此链路，无需改动）

**具体操作**：

1. 预览控制器：`preview(path, name)` → 按扩展名构造 URL：docx → `/docs/?open=path:<abs>`，md → `/markdown/?open=path:<abs>`（`<abs>` 需 `encodeURIComponent` 整个 `path:` 前缀）
2. iframe 挂载：`src=构造 URL`；`loading` 态（iframe onLoad）+ `error` 态（onError / 超时 10s → 显示错误与重试）
3. 只读保障（BR-011）：预览文档在 relay 侧是字节副本；iframe 内 Ctrl+S 触发下载而非写回——实测原文件 sha256 前后一致（`shasum -a 256 <file>` 对比）
4. 预览区提供「在浏览器中打开」按钮（接线 Task 14）

**验证**：browser 实测：点击 .docx → iframe 渲染"标题第一段。第二段。"（用 fixtures/generated/simple.docx）；预览前后 `shasum -a 256 fixtures/generated/simple.docx` 一致；iframe 内 Ctrl+S 出现下载而非写回

**Evidence**：`evidence/UF-002/preview-docx.png` + `evidence/UF-002/hash-before-after.txt`

**注意事项**：禁止 iframe sandbox 属性导致文档交互失效（需允许 same-origin 以加载 relay 资源——用 sandbox="allow-scripts allow-same-origin" 并实测）；iframe 每次预览重建（避免陈旧状态）

### Task 14: 实现「在浏览器中打开」按钮

- **关联**：BR-008 / UF-003 / EVD-003
- **前置任务**：13
- **风险等级**：P2

**为什么做**：用户确认"支持跳转"——完整编辑器体验。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/tabs/genoffice.tsx`：预览工具栏

**具体操作**：

1. 预览工具栏加「在浏览器中打开」按钮：`window.open(iframeSrc, '_blank', 'noopener')`
2. 弹窗拦截失败（window.open 返回 null）→ 面板内提示"请允许弹窗后重试"（UF-003 失败分支）

**验证**：browser 实测点击按钮 → 新标签打开完整编辑器（可编辑）；拦截场景（浏览器设置禁用弹窗）→ 提示出现

**Evidence**：`evidence/UF-003/open-new-tab.png`

### Task 15: 执行 Phase 3 回归验证

- **关联**：UF-002 / UF-003 全分支 / BR-011 / INV-005
- **前置任务**：12;13;14
- **风险等级**：P1

**验证**：列表/预览/打开三环节主路径 + 全部失败分支（relay 停、路径不可读、类型不支持、空目录、弹窗拦截）；`node web/smoke-test.mjs` 全绿（INV-005 初步）；console 无 error

**Evidence**：`evidence/phase-3/`

### Phase 4: 文件 tab

> 你在哪里：文件 tab 占位
> 做完之后：host.listDirectory 目录浏览（BR-009, UF-004）

### Task 16: 实现文件管理面板（host.listDirectory）

- **关联**：BR-009 / UF-004 / EVD-004
- **前置任务**：11
- **风险等级**：P1

**为什么做**：独立于 GenOffice 的通用文件浏览（用户确认"文件管理"）。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/tabs/files.tsx`（新建）：面板组件
- `.dsh-plugin-dev/packages/client/connection/src/client/fixture.ts`：`listDirectory` 返回形状参考，`rg "listDirectory"`，L2082
- `.dsh-plugin-dev/packages/client/connection/src/client/index.ts`：`ctx.connection.api`，L49-L67（数据通道）

**具体操作**：

1. 数据源：`ctx.connection.api.host.listDirectory(path?)`（`host` 域，DSH host 侧执行，无跨域）；`isLoopback` 为 false 时提示降级（非本机场景）
2. UI：当前路径栏、上级/主目录按钮、目录进入、文件/目录图标区分、错误态（RpcResponse 非 ok 或 reject → 错误行 + 保留上次列表）、host 断连提示（UF-004 失败分支）
3. 状态机对齐 UF-004：`idle → loading → list | error`

**验证**：browser 实测：进入 `/tmp` → 列表出现；`..` 返回；主目录按钮回 home；故意传不可读路径 → 错误态且列表保留

**Evidence**：`evidence/UF-004/files-browse.png` + `evidence/UF-004/files-error.png`

**注意事项**：禁止在 client 侧用 fetch 拼 host 路径（必须走 `ctx.connection.api`）；`listDirectory` 的 request 形状以 `host.schema.ts` 为准（`rg "host.listDirectory" .dsh-plugin-dev/packages/host-apiproxy`）

### Task 17: 执行 Phase 4 回归验证

- **关联**：UF-004 全分支 / INV-001
- **前置任务**：16
- **风险等级**：P2

**验证**：文件浏览主路径 + 错误/断连分支；工作区 tab 不受影响；console 无 error

**Evidence**：`evidence/phase-4/`

### Phase 5: 终端 tab

> 你在哪里：终端 tab 占位；node-pty 在依赖树（dsh-pty-local）
> 做完之后：xterm + host pty ws 双向实时、会话生命周期（BR-010, UF-005）

### Task 18: 实现 host 侧 pty WebSocket 端点

- **关联**：BR-010 / UF-005 / INV-006 / EVD-005（UF: NA——host 服务；用户可见部分由 Task 19 承接，本任务说明其原因）
- **前置任务**：8
- **风险等级**：P0（ASM-005 验证点）

**为什么做**：DSH 无 pty client 传输，需要 host 插件提供 WebSocket 通道 + node-pty 会话。

**涉及文件与定位**：

- `genoffice/dsh-plugin/host/src/index.ts`（新建）：host 侧 cordis 插件
- `.dsh-plugin-dev/packages/pty/pty/src/types.ts`：`PtySpawnRequest`，`rg "PtySpawnRequest"`，L40（{type, name?, cwd?}）
- `.dsh-plugin-dev/packages/pty/pty-local/src/index.ts`：node-pty backend 参考，`rg "nodePty"`，L8/L99
- DSH host httpServer 注册方式：`待勘察`（rg `httpServer` .dsh-plugin-dev/packages/bundle/base/ 及既有 ws 端点如 `MUX_EVENTS_PATH` 的注册处）

**具体操作**：

1. 勘察并记录 host 侧注册 WebSocket 端点的方式（复用 DSH 既有 `/api/events.*` ws 的注册模式）
2. host 插件：`/api/pty.ws` 端点——握手后 spawn shell（优先复用 DSH 既有服务：`ctx.pty.spawn(owner, {type:'local', cwd: homedir()})`，owner 用当前会话 Agent；复用失败再直接 node-pty）
3. 消息协议：client→host `{type:'input', data}`；host→client `{type:'output', data}` / `{type:'exit', code}` / `{type:'error', message}`；帧为 JSON 行
4. 会话生命周期：ws close/error → 销毁 pty（kill + close）；会话注册表 Map<ws, session>；页面断连 30s 无心跳自动销毁（防孤儿，INV-006）
5. cwd：默认用户主目录；`cwd` 请求字段可覆盖

**验证**：Playwright page.evaluate 建 WebSocket：发送 `echo hello\n` → 收到含 `hello` 的 output 帧；close 后 `ps aux | grep -c <shell>` 无新增残留

**Evidence**：`evidence/UF-005/ws-echo.log` + `evidence/UF-005/no-orphan.txt`

**注意事项**：禁止把 pty 会话交给未认证来源（ws 握手校验 `Origin` 为 loopback 或 DSH 页面）；禁止 spawn 常驻进程泄漏（异常路径也走销毁）；node-pty 为原生模块，加载失败要给出明确错误帧

### Task 19: 实现 client 终端面板（xterm.js）

- **关联**：BR-010 / UF-005 / EVD-005
- **前置任务**：18
- **风险等级**：P1

**为什么做**：终端 UX（用户确认"类 terminal"面板）。

**涉及文件与定位**：

- `genoffice/dsh-plugin/src/tabs/terminal.tsx`（新建）：xterm.js 集成
- `genoffice/dsh-plugin/package.json`：加 `xterm` / `xterm-addon-fit` 依赖（ASM：npm 安装 xterm@5）

**具体操作**：

1. 面板挂载：创建 xterm 实例（fit 插件自适应面板宽度）、建立 `ws://127.0.0.1:<dshPort>/api/pty.ws`（端口从 `location.port` 推断）
2. 双向：`term.onData(d => ws.send({type:'input', data:d}))`；ws message → `term.write(data)`；`{type:'exit'}` → 显示退出码
3. 连接状态机（UF-005）：`disconnected → connecting → connected → closed`；失败显示"连接失败"+ 重连按钮（指数退避 1s/2s/5s）
4. 生命周期：组件卸载（切 tab/折叠到 rail 不可见）→ 关闭 ws（host 侧销毁会话，INV-006）；重新激活 → 新会话（BR-010 允许重建）
5. Ctrl+C 等按键由 xterm 默认发送，host 侧 pty 处理

**验证**：browser 实测：终端出现 shell 提示符；`echo hello` 输出 `hello`；`Ctrl+C` 中断 `sleep 100`；切走 tab 再切回 → 新会话可用；`ps aux | grep -c sleep` 在切走后归零

**Evidence**：`evidence/UF-005/terminal-echo.png` + `evidence/UF-005/terminal-ctrl-c.png`

**注意事项**：禁止在面板不可见时保持 ws 连接（资源泄漏）；xterm 版本与 React 严格模式兼容性实测；`fit` 在面板宽度变化（拖拽）时调用 `term.fit()`

### Task 20: 执行 Phase 5 回归验证

- **关联**：UF-005 全分支 / INV-006
- **前置任务**：18;19
- **风险等级**：P1

**验证**：终端主路径 + 失败分支（ws 失败重连、切 tab 销毁）；`ps` 无残留；console 无 error

**Evidence**：`evidence/phase-5/`

### Phase 6: 集成验收

> 你在哪里：四个 tab 各自可用
> 做完之后：profile 加载完整插件、5.2 真实场景全套通过、全量回归绿、evidence 归档

### Task 21: profile 最终集成与安装固化

- **关联**：BR-001 / INV-004 / EVD-008
- **前置任务**：11;15;17;20
- **风险等级**：P0

**为什么做**：把全部面板与 host 插件一次性装入 profile，并固化安装步骤（README）。

**涉及文件与定位**：

- `~/.dsh/profiles/web/cordis.patch.yml`：insert 列表（client + host 插件行）
- `~/.dsh/profiles/web/package.json`：`dsh.profile.bundles` 与 dependencies（本地链接）
- `genoffice/dsh-plugin/README.md`：安装/卸载/回退说明（patch disable 即回退官方）

**具体操作**：

1. patch 最终化：disable `ui-sidebar` 行 + insert client 插件 + insert host 插件（id/name 与既有行同构）
2. 依赖固化：`file:` 链接 + `pnpm install`；README 记录重装命令与回退（注释掉 patch 行即还原）
3. 干净启动验证：从零执行 README 安装步骤 → `dsh web` → 四个 tab 全部出现且可用
4. 卸载验证：patch 注释后重启 → 官方侧边栏原样恢复（回退可用性，EVD-001）

**验证**：全新安装路径一次成功；回退后官方侧边栏截图对比无差异

**Evidence**：`evidence/phase-6/install.log` + `evidence/UF-001/fallback-official.png`

**注意事项**：禁止把安装步骤写成只有本机可用的绝对路径（README 用变量占位）；回退验证必须真实执行一次

### Task 22: 执行 spec 5.2 真实场景全套测试

- **关联**：全部用户可见 UF（UF-001~UF-006）
- **前置任务**：21
- **风险等级**：P0

**验证**：按 5.2 执行矩阵逐行回放（主路径 + 全部失败分支），每行核对界面反馈与 console/network；全部通过才算本任务完成

**Evidence**：`evidence/UF-xxx/`（按矩阵行归档）

**注意事项**：禁止用"单测通过"或"代码审查"替代本节；失败一行即回到对应任务修复重跑

### Task 23: 全量回归与 evidence 收尾

- **关联**：INV-001~INV-006 / EVD-009
- **前置任务**：22
- **风险等级**：P1

**验证**：genoffice 6 个 e2e 全绿 + DSH 官方功能回归（会话创建/切换/设置）+ `ps` 无残留 + console 无 error；evidence 目录与 2.5 节 EVD 清单逐一核对；tasks.csv 全部更新为已完成

**Evidence**：`evidence/phase-6/regression.log`

---

## 5. 验收与 Review 协议

> **验收铁律：命令级验证（5.1）通过只是入场券，不是完成。** 用户可见的需求必须通过 5.2 真实场景全套测试才算完成——单元测试全绿但界面点不动 = 未完成。

### 5.1 命令级验证（入场券）

| 验证项 | 命令 | 期望 | Evidence |
|---|---|---|---|
| 插件包 typecheck | `cd dsh-plugin && npm run typecheck` | 0 error | EVD-008 |
| 插件包构建 | `cd dsh-plugin && npm run build` | 产物生成、可加载 | EVD-008 |
| relay 端点 | `curl "http://localhost:8787/api/dir?path=/tmp"` | `{ok:true, entries:[...]}` | EVD-006 |
| relay CORS | `curl -i -H "Origin: http://127.0.0.1:3080" http://localhost:8787/api/health` | 含 ACAO 回显头 | EVD-007 |
| relay 安全 | `HOST=0.0.0.0` 无开关 → `curl /api/file` | 禁用错误（文案同基线） | EVD-007 |
| genoffice 回归 | `node web/e2e-url-open.mjs` 等 6 脚本 | 全绿 | EVD-009 |
| pty 无残留 | `ps aux | grep -E "sleep|bash" | grep -v grep` | 无新增进程 | EVD-005 |

### 5.2 真实场景全套测试（Real-Run，完成的唯一标准）

> 在真实运行的应用上，把第 2.3 节每条流程脚本从头到尾走一遍——用和真实用户完全相同的方式。禁止用"跑了单测"或"读了代码确认逻辑正确"代替本节。

**环境准备**：

| 项 | 值 |
|---|---|
| 启动命令 | `cd ~/.dsh/profiles/web && pnpm install`（插件已链入）后运行 `/Users/nothing/workspace/dsh/test-Nothing1024/bin/dsh web`（或 PATH 中 `dsh web`）；relay：`cd /Users/nothing/workspace/dsh/genoffice && node web/server.mjs` |
| 访问入口 | DSH GUI `http://127.0.0.1:3080`（侧边栏）；relay `http://localhost:8787` |
| 测试账号/数据 | 无需账号；测试文件：`genoffice/fixtures/generated/simple.docx`（内容"标题第一段。第二段。"）与一个临时 `.md` |
| 干净状态定义 | 重启 `dsh web`；relay 重启；浏览器无痕窗口 |
| 可用测试工具 | Playwright（chromium，已有）+ curl；DSH GUI 用 Playwright 打开 127.0.0.1:3080 实际操作侧边栏 |

**执行矩阵**（每条 = 2.3 节一条流程脚本的真实回放）：

| UF | 执行方式 | 操作来源 | 必须核对的点 | Evidence |
|---|---|---|---|---|
| UF-001 主路径 | browser | 2.3 节 UF-001 步骤 1-3 逐条点击四个 tab | 每步即时反馈与脚本一致；激活态高亮；console 无新增 error | `evidence/UF-001/tabs.png` + console.log |
| UF-001 失败分支（子槽位缺失） | browser | 临时注释某个 tab 插件行重启 | 该 tab 隐藏/不可用，其余正常 | `evidence/UF-001/missing-slot.png` |
| UF-001 失败分支（渲染异常） | browser | 临时注入 throw 组件 | 错误边界占位，不白屏 | `evidence/UF-001/error-boundary.png` |
| UF-002 主路径 | browser | 2.3 节 UF-002 步骤 1-3：列目录→点击 simple.docx→预览 | iframe 渲染"标题第一段。第二段。"；加载态可见；hash 前后一致 | `evidence/UF-002/preview-docx.png` + hash 记录 |
| UF-002 失败分支（relay 停） | browser | 停 relay 后刷新列表/点文件 | "中继服务未启动"+ 重试恢复 | `evidence/UF-002/relay-down.png` |
| UF-002 失败分支（类型不支持） | browser | 点击 .xlsx 文件 | 提示"仅桌面版可用"，行不可点 | `evidence/UF-002/unsupported.png` |
| UF-002 失败分支（空目录） | browser | 进入空目录 | "空目录"占位 | `evidence/UF-002/empty-dir.png` |
| UF-003 主路径 | browser | 2.3 节 UF-003：点「在浏览器中打开」 | 新标签完整编辑器（可编辑） | `evidence/UF-003/open-new-tab.png` |
| UF-004 主路径 | browser | 2.3 节 UF-004 步骤 1-3：进入 /tmp、上级、主目录 | 列表即时刷新、路径栏正确 | `evidence/UF-004/browse.png` |
| UF-004 失败分支（路径错误） | browser | 访问不可读目录 | 错误提示 + 列表保留 | `evidence/UF-004/error.png` |
| UF-005 主路径 | browser | 2.3 节 UF-005 步骤 1-3：echo/Ctrl+C/exit | 实时回显；中断生效；`ps` 无残留 | `evidence/UF-005/echo.png` + `ps` 输出 |
| UF-005 失败分支（ws 失败） | browser | 停 host 插件后开终端 | "连接失败"+ 重连按钮，恢复后可用 | `evidence/UF-005/ws-down.png` |
| UF-006 主路径 | browser | 2.3 节 UF-006：切 GenOffice→折叠→展开 | 恢复 GenOffice tab | `evidence/UF-006/restore.png` |

**按任务类型的执行方式**：

- frontend：真实浏览器（Playwright 打开 127.0.0.1:3080）实际点击，截图 + console + network 三件套
- backend/API：对真实 relay 发 curl（正常/权限/参数错误各一发），保存 request/response 样例 + server log
- CLI/脚本：`dsh web` 真实启动、README 安装步骤真实执行

**通过标准**：执行矩阵全部行通过且 evidence 齐全。任何一行失败 = 本需求未完成，回到对应任务修复后重跑。

### 5.3 Evidence 目录结构与命名

```text
evidence/
  phase-{0..6}/     # 每 Phase 的命令输出、Phase summary
  UF-{xxx}/         # 截图、console log，文件名含 UF 编号和状态
  API-dir/          # /api/dir 样例
  API-cors/         # CORS 头样例
```

- EVD ID 必须能在第 2.5 节找到。
- 截图命名：`UF-002-preview-docx.png`；API 样例命名：`API-dir-{scenario}.json`。

### 5.4 Review 专项检查清单

> 实现完成后的专项检查。通用 L1-L4 流程见 skill 的 review mode，此处只列本需求特有项。

- [ ] 侧边栏选项卡栏与四面板从真实入口（侧边栏 UI）可达，不是只有孤立组件
- [ ] 官方工作区列表/设置功能在容器内完整可用（INV-001）——创建会话、切换会话、搜索、设置逐项点过
- [ ] iframe 预览只读：原文件 sha256 前后一致；Ctrl+S 触发下载不写回（BR-011）
- [ ] relay `/api/dir` 与 CORS 的安全边界：网络暴露无开关时返回禁用错误（BR-005/BR-006）
- [ ] 终端无孤儿进程：切 tab/关页面后 `ps` 干净（INV-006）
- [ ] 5.2 执行矩阵全部通过，evidence 齐全且与 2.5 节 EVD 清单一致
- [ ] 2.3 节每条流程的「入口接线清单」已实现——选项卡按钮、文件行、目录行、预览按钮、终端 ws 均已接线
- [ ] 界面交互与 2.3 节脚本逐步一致（loading、禁用态、错误提示、成功反馈都存在）
- [ ] 所有 BR/UF/INV 状态可对照第 2 章逐条核销
- [ ] DSH 官方包零源码修改（`git -C .dsh-plugin-dev status --short` 干净）
- [ ] patch 回退验证执行过：注释插件行后官方侧边栏原样恢复

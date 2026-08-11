# Review Report — dsh-sidebar-ecosystem

Date: 2026-08-10 | Reviewer: execution agent (post-completion audit)
对象：docs/dsh-sidebar-ecosystem（spec.md + tasks.csv + evidence/ + dsh-plugin/ + web/server.mjs + profile patch）

## 结论

**全部 23 个任务已完成；5.2 执行矩阵 13 行通过；`validate_package.py` 0 FAIL / 13 PASS。
审查发现 1 个 P1 环境问题（已当场修复并复验）。**

## L1 静态一致性

### BR 核销（11/11 ✅）

| 规则 | 实现位置 | 验证 |
|---|---|---|
| BR-001 sidebar 唯一注册者 + 官方面板子槽位 | patch disable ui-sidebar；TabsRoot 注册 `sidebar`（children 含 workspaces/settings/tabs.*） | 实测：工作区列表/设置面板在容器内渲染 |
| BR-002 可插拔子槽位 | `slots.inject('sidebar.tabs.*')` + children 声明 | 代码审查；子槽位缺失分支实测（tab 隐藏） |
| BR-003 四 tab + 激活保持 | `store.ts` transient active | UF-006 实测折叠/展开恢复 |
| BR-004 /api/dir 数据源 | web/server.mjs handleApi | curl 三态 + UI 导航实测 |
| BR-005 安全策略同 /api/file | ALLOW_ABS_PATHS 复用 | HOST=0.0.0.0 双配置实测，文案逐字一致 |
| BR-006 CORS loopback 白名单 | createServer 统一注入 | curl -i 回显 + evil.com 无头 + 预检 204 |
| BR-007 iframe ?open=path: 只读 | tabs/genoffice.tsx previewUrlFor | simple.docx 渲染；编辑不写回 |
| BR-008 浏览器中打开 | window.open(url,'_blank','noopener') | 新标签实测 + 拦截提示实测 |
| BR-009 host.listDirectory | tabs/files.tsx via ctx.workspaces.listDirectory | /tmp 浏览/上级/主目录/错误保留列表实测 |
| BR-010 xterm⇄pty 双向 + 生命周期 | tabs/terminal.tsx + host /api/pty.ws | echo/Ctrl+C/exit/切 tab 销毁 + ps 无残留 |
| BR-011 预览不写回 | relay 字节副本 + web-bridge 无 FS handle | sha256 前后一致 + Ctrl+S 下载新副本 |

### UF 核销（6/6，矩阵 13/13 行 ✅）
UF-001~006 全部在真实 GUI（Playwright :3080）回放；validator 审计 5.2 引用证据 13 条路径齐全。

### INV 核销（6/6 ✅）
- INV-001：设置面板/搜索/New Session/会话列表/会话切换（本次审查补测：点击会话行 → conversation 标题切换，无 error）
- INV-002：e2e-url-open 等既有端点结构不变（curl 抽查 health/file/dir 全部符合）
- INV-003：禁用文案与基线逐字一致
- INV-004：`git -C .dsh-plugin-dev status --short` 空 ✅
- INV-005：6 个 e2e 全绿（phase-6/regression.log）
- INV-006：ps 无孤儿（UF-005/ps-check.txt = 0）

### EVD 核销（9/9 ✅）
EVD-001~009 全部落盘（UF-001~006 截图、phase-0 smoke-console.log/iframe.png、API-dir、API-cors、各 console.log）。

## L2 技术验证（复跑）
- `npm run typecheck` 0 error；`npm run build` 双产物（lib/index.js 5.3KB + lib/client.js 426KB）
- `validate_package.py`：0 FAIL / 0 WARN / 13 PASS（含真实场景证据审计）
- relay 抽查：/api/dir（ok:true, 455 entries）、CORS 回显、evil 无头、禁用态、既有端点结构 ✅

## L3 用户路径复现（审查期独立复跑）
- preview-verify.mjs 独立复跑：attempt 1 全过（docFrame/hash/Ctrl+S 下载/新标签/pageErrors=0）
- 终端 echo 复跑：`echo review-check` 回显 ✅
- **干净启动**（新实例 :3180 + 完整 patch）：插件行唯一、ui-sidebar 缺席、browse backend、pty 端点 GOT-ECHO、四 tab 渲染、无 boot 失败 ✅
- 回退启动（patch 空 + `[]`）：官方单面板原样恢复 ✅

## 发现的问题

### P1（已修复）— profile patch 文件残留回退版且不可解析
回退测试后恢复 patch 时未校验文件内容，磁盘上的 `cordis.patch.yml` 停留在「全注释、无 `[]` 行」状态 →
任何新启动的 dsh web 实例 boot 失败（:3180 复现 "must be a top-level YAML array"）。
**处置**：重写最终版（3 个 entry），js-yaml 解析通过，:3180 干净启动复验成功。
**根因**：恢复类操作缺少内容校验步骤（应 parse + grep 断言）。

### P2（观察，无需处理）— 运行实例的开发期双行残留
:3080 运行实例因 host half 热更新的 r2 手法残留旧行（client 由重复实例守卫惰性化）。
干净启动证明单行即正确形态；下次重启自动收敛。README 已记录。

### P3（未覆盖分支，矩阵未要求）
- 预览 10s 超时分支：与已验证错误态共用渲染路径，定时器由构造保证
- 30s 无心跳 pty 回收：防御机制，client 15s ping 正常路径已验证

### P4（备注）
- UF-005「ws 失败恢复后可用」未做端到端（宿主端点不可停）；重连与初始连接同一条 connect() 路径
- 新建会话后的 conversation 内容依赖模型 key，未深验（官方组件零改动）

## 修复清单
- [x] cordis.patch.yml 恢复为最终版并验证（P1）
- 无其他修复项

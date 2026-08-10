# dsh-sidebar-ecosystem Handoff

本文件是可直接交给 Codex / Claude / Generic Coding Agent 的交付 Prompt。你的目标不是"按文件改代码"，而是在不破坏业务不变量的前提下，完成 spec 定义的用户可见行为。

> 使用方式：把本文件完整粘贴给执行 Agent，或让 Agent 开工前先读本文件。
> 本文件只做入口导航，不复制 spec 内容；所有规则、任务、验收细节以 `spec.md` 为准。

## 1. 目标

在 DSH Web GUI 侧边栏实现"统一生态"：选项卡容器（工作区/终端/GenOffice/文件），GenOffice 面板自带文件浏览器、点击文件在侧边栏内嵌 iframe 只读预览并可"在浏览器中打开"跳转——通过 cordis 插件（替换官方 sidebar 注册者）与 genoffice relay 增量 API（/api/dir + CORS）完成，DSH 官方包零修改。

## 2. 资料清单

| 资料 | 路径 | 状态 | 用途 |
|---|---|---|---|
| Spec（唯一事实源） | `spec.md` | found | 业务合同（BR/UF/INV/EVD）、技术方案、Task-1~23 详情、5.2 验收矩阵 |
| Tasks CSV（状态板） | `tasks.csv` | found | 23 条任务状态跟踪（P0~P6） |
| Evidence 目录 | `evidence/` | found | 证据归档（phase-*/UF-*/API-* 子目录） |

缺失资料与假设：

- ASM-001（本地插件包 file: 链接加载链路）、ASM-002（DSH web 无 frame-src 限制）、ASM-003（官方 SidebarRoot 未导出需自绘 rail）、ASM-005（pty ws 端点集成方式）——全部由 Task 1 / Task 18 实测验证，验证结果回写 spec §1.3/§1.4。
- 开发用 DSH 源码 worktree：`genoffice/.dsh-plugin-dev`（分支 `genoffice-web-plugin`，基于 test-Nothing1024 快照 c15895f）；**禁止修改其中任何官方包源码**。

## 3. 开工上下文

### 架构 Before / After

```text
Before:  DSH sidebar slot ← ui-sidebar(单面板) ← sidebar.workspaces/settings
         genoffice relay(:8787) 无 CORS、无 /api/dir

After:   DSH sidebar slot ← dsh-genoffice-sidebar(TabsRoot: 工作区|终端|GenOffice|文件)
             ├─ sidebar.workspaces（官方保留）
             ├─ sidebar.settings（官方保留）
             └─ sidebar.tabs.terminal|genoffice|files（可插拔子槽位）
         genoffice relay + CORS(loopback 白名单) + /api/dir
```

### Phase 地图

```text
P0 基线与勘察 → P1 relay 配套(/api/dir+CORS) → P2 插件骨架(TabsRoot) → P3 GenOffice tab → P4 文件 tab → P5 终端 tab → P6 集成验收
```

### 最关键规则（Top 10，全量见 spec.md 第 2 章）

- BR-001: TabsRoot 是 sidebar 槽位唯一注册者（patch disable 官方 ui-sidebar）；官方面板以子槽位保留
- BR-003: 激活 tab 会话内保持（折叠/展开恢复）
- BR-004/BR-005: relay /api/dir 与 /api/file 同安全策略（loopback 默认允许，网络暴露需 GENOFFICE_WEB_OPEN_PATHS=1）
- BR-006: relay CORS 仅回显 loopback Origin（localhost/127.0.0.1 任意端口），禁止 * 通配
- BR-007/BR-011: 预览 iframe 用 ?open=path:<绝对路径>，只读（保存=下载，原文件 hash 不变）
- BR-008: 「在浏览器中打开」= window.open 新标签
- BR-010: 终端会话与面板生命周期联动，无孤儿进程
- UF-001~UF-006: 选项卡切换 / GenOffice 预览 / 浏览器打开 / 文件浏览 / 终端 / 折叠恢复（2.3 节有逐步脚本）
- INV-001: 官方工作区/设置功能不回归
- INV-004: DSH 官方包零源码修改（git -C .dsh-plugin-dev status 必须干净）

### 禁止事项

- 不得修改 DSH 官方包源码（INV-004）；一切改动走 genoffice 仓库 dsh-plugin/ + profile patch
- 不得为通过测试放松 relay 安全边界（BR-005/BR-006）
- 不得只按行号修改；必须用 symbol/rg anchor 校验（三段式定位见 spec.md 第 3.3 节）
- 不得只实现组件/函数而不接线到真实入口（选项卡按钮、文件行、目录行、预览按钮、终端 ws）
- 不得跳过交互反馈（loading、禁用、错误提示、成功反馈）
- 不得只跑单测就宣称完成——完成的唯一标准是 spec.md 第 5.2 节真实场景全套测试（13 行执行矩阵）

## 4. 开工前初始化

1. 通读 `spec.md` 第 1、2 章（事实基线 + 业务合同，重点读 2.3 节流程脚本）。
2. 预读 spec.md 第 5 章验收协议——先知道完成标准（5.2 真实场景测试），再开工。
3. 打开状态板 `tasks.csv`，结合第 4 章找到第一条可执行任务（Task 1：冒烟插件验证加载链路）。
4. 运行 `git status` 确认工作区状态；`git -C .dsh-plugin-dev status --short` 必须为空。
5. 运行基线命令：`curl http://localhost:8787/api/health`（relay）与 `/Users/nothing/workspace/dsh/test-Nothing1024/bin/dsh web`（DSH GUI，勿与 genoffice relay 端口混淆：DSH=3080，relay=8787）。

## 5. 核心执行循环

```text
WHILE 存在待开始或进行中的任务:
    1. 找到下一条前置任务已完成的任务
    2. 读 spec.md 第 4 章对应 Task 详情
    3. 回答：关联 BR/UF/INV/EVD 是什么？哪些行为不能变？
    4. 状态板更新为「进行中」
    5. 按三段式定位校验文件位置
    6. 执行具体操作
    7. 运行验证命令并保存 evidence
    8. 通过 → 状态「已完成」；失败 → 排障，最多主动修复 3 次
    9. 仍失败 → 标记「已阻塞:{原因}」，继续不依赖该任务的后续任务
   10. Phase 回归通过后，输出 Phase summary（evidence/phase-N/），再进入下一 Phase
```

不要中途问"是否继续"。除非所有剩余任务都被阻塞，否则继续推进。

## 6. 排障顺序

1. 查 spec.md 第 4 章当前任务的注意事项。
2. 查 spec.md 第 2 章关联 BR/UF/INV。
3. 按错误类型定位：插件加载（patch/依赖链）→ slots 注册（children/inject 形状）→ relay（curl 直测）→ UI 状态 → 终端 ws。
4. 关键探测命令：
   - 插件是否被加载：DSH GUI F12 console 找插件日志；`curl -s http://127.0.0.1:3080/ | grep -c genoffice`
   - relay 探测：`curl http://localhost:8787/api/health`、`curl "http://localhost:8787/api/dir?path=/tmp"`
   - CORS 探测：`curl -i -H "Origin: http://127.0.0.1:3080" http://localhost:8787/api/health`
   - 无浏览器时：Playwright 脚本（参考 genoffice/web/e2e-*.mjs 的写法）
5. 最多主动修复 3 次，仍失败则阻塞并继续其他任务。

## 7. 完成标准与汇报

所有任务「已完成」后：

1. 运行最终验收命令：`python3 /Users/nothing/.agents/skills/prd-workflow/scripts/validate_package.py .`（命令级，入场券）→ 期望 0 FAIL。
2. **执行 spec.md 第 5.2 节真实场景全套测试**：启动 `dsh web`（:3080）+ relay（:8787），用 Playwright 打开 DSH GUI 按 2.3 节流程脚本逐条回放 13 行执行矩阵（主路径 + 失败分支），保存截图/console/API 样例到矩阵写明的 `evidence/` 路径。任何一行失败 = 未完成，回去修。
3. 重跑 `python3 /Users/nothing/.agents/skills/prd-workflow/scripts/validate_package.py .`——它会审计真实场景任务（Task 22）的证据是否落盘（evidence 缺失 = FAIL，不得宣称完成）。
4. 对照 spec.md 第 2 章逐条核对 BR/UF/INV/EVD。
5. 对照 spec.md 第 5.4 节专项检查清单自检（含入口接线可达性、官方包零修改、patch 回退实测）。
6. 输出最终总结：

```markdown
## 完成总结
- 完成范围：...
- 修改文件：...
- 通过的 BR/UF：...（真实场景执行矩阵 N/N 行通过）
- 未破坏的不变量：...
- Evidence：evidence/...
- 剩余风险：...
```

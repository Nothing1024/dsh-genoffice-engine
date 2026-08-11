# Phase 4 — 文件 tab summary

Date: 2026-08-10 | Tasks: 16, 17 — 已完成

## Task 16: 文件管理面板（BR-009, UF-004）

`src/tabs/files.tsx` + `files.module.css`：数据源 `ctx.workspaces.listDirectory`（runtime 服务包装
`host.listDirectory` RPC，浏览器直连 host 无跨域）；状态机 idle→loading→list|error（错误时**保留上次列表**）；
路径栏（⌂ 主目录 / .. 上级 / 刷新 + 当前路径）；上级来自响应 crumbs 祖链倒数第二节；隐藏条目过滤；
RPC 失败 → DirectoryBrowseError.message 错误行 + 重试；host 断连 → catch 分支提示。

**关键架构发现**：`host.listDirectory` 需要 directory-picker 的 **browse** 能力；本机 auto 解析器
（dsh-host-directory-picker-auto）在 macOS loopback 下解析为 `native`（无列目录能力）→
`directory-picker-unavailable`。解决：profile patch `- id: directory-picker / disabled: true` +
insert `@deepseek-ai/dsh-host-directory-picker-browse`（官方自带的后备后端，其浏览器半自动进 manifest）。
这是纯 profile 组合变更（INV-004 合规）；工作区创建流程的目录选择器变为官方内置 browse 对话框（其自身 UX 完备）。

实测（Playwright 真机）：
- 主目录列出（/Users/nothing + 目录行）（files-browse.png）
- 进入 /tmp → 上级 → 主目录 全通（路径栏正确）
- 错误分支：进入 chmod 000 的 /tmp/genoffice-denied → 错误提示 + 上次列表保留（files-error.png）
- console 无 error

## Task 17: Phase 4 回归验证

- 文件浏览主路径 + 错误分支 ✓；工作区 tab 不受影响（会话列表正常渲染）✓；console 无 error ✓

## 遗留

- 工作区创建流程（目录选择器换成 browse 对话框）的完整点验放 Task 22（INV-001 矩阵行）。
- /tmp/genoffice-denied 测试目录在 Task 22 结束后恢复权限并清理。

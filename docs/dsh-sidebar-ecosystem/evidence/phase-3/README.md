# Phase 3 — GenOffice tab summary

Date: 2026-08-10 | Tasks: 12, 13, 14, 15 — 已完成

## Task 12: GenOffice 文件列表面板（BR-004/005, UF-002）

`src/tabs/genoffice.tsx` + `genoffice.module.css`：状态机 idle→loading→list|error；
路径栏（⌂ 主目录 / .. 上级 / 刷新 + 当前路径）；目录行进入；docx/md 行可点击预览，
其他类型置灰 + 「仅桌面版可用」tag；空目录占位；错误态「中继服务未启动」+ 重试（relayDown 分支）；
隐藏文件过滤（relay 排序+前端过滤）；符号链接 🔗 标记且可导航（不追链策略在 relay 侧）。

实测（Playwright，真机 :3080 + relay :8787）：
- 主目录加载 / 进入 /tmp / 进入 genoffice-preview-test / .. 上级 / 主目录 —— 路径栏正确（list.png）
- 空目录 → 「空目录」占位（empty-dir.png）
- sheet.xlsx → 置灰 + 「仅桌面版可用」（unsupported.png）
- relay 停止 → 「中继服务未启动」+ 重试按钮；relay 重启后点重试 → 列表恢复（relay-down.png / relay-recovered.png）

## Task 13: iframe 预览（BR-007/BR-011, UF-002）

- 预览控制器：docx → `/docs/?open=path:<abs>`，md → `/markdown/?open=path:<abs>`（encodeURIComponent 整个 path: 前缀）
- iframe keyed by `url:retryKey`（每次预览重建）；loading 态（onLoad）；10s 超时 → 错误+重试；
  `sandbox="allow-scripts allow-same-origin allow-downloads"`（允许 relay 同源资源 + 保存下载）
- 实测（preview-verify.mjs，attempt 1 全过）：
  - simple.docx 预览 iframe 渲染（docs 应用 UI：已保存/自动保存/工具栏/编辑区）
  - 预览前后 `shasum`/base64 一致：hashUnchangedAfterPreview=true
  - 编辑预览内容 + Ctrl+S → **触发下载**（simple.docx 新副本）而非写回：ctrlSDownload=true
  - 保存后原文件 hash 不变：hashUnchangedAfterCtrlS=true
  - 写回不可达性由架构保证：path: 打开的文档无 FS handle，web-bridge saveDocx 必然 fallback downloadBytes
- 测试排障记录：早期"框架不出现"实为测试脚本 bug（`frame.focus()` 缺 selector 参数），产品代码无问题；
  docs 应用冷启动偶发超过 10s 预览超时（正确落入错误+重试分支），脚本内置重试循环

## Task 14: 在浏览器中打开（BR-008, UF-003）

- `window.open(url, '_blank', 'noopener')`；返回 null（弹窗拦截）→ 面板内提示「弹窗被拦截 — 请允许弹窗后重试」
- 实测：点击 → 新标签打开完整 markdown 编辑器（open-new-tab.png，可编辑工具栏可见）；
  模拟 `window.open=()=>null` → 提示出现（popup-blocked.png）

## Task 15: Phase 3 回归验证

- 列表/预览/打开三环节主路径 + 全部失败分支（relay 停→恢复、类型不支持、空目录、弹窗拦截）✓
- `node web/smoke-test.mjs` 全绿（console errors: none，INV-005 初步）✓
- console 无 error（各探测 pageErrors 为空）✓

## 遗留

- 预览 10s 超时分支与 relay-down 错误态共用渲染路径（已验证）；超时本身由构造保证
  （10s 定时器 → setPreviewError），未单列矩阵行。
- 测试 fixtures：`/tmp/genoffice-preview-test/{simple.docx, sample.md, sheet.xlsx, empty/}`。

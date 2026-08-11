# Phase 0 — 基线与勘察 summary

Date: 2026-08-10 | Tasks: 1, 2, 3 — 已完成

## Task 1: 冒烟插件包 + DSH 加载链路（ASM-001 / ASM-002 实测结论）

**ASM-001 确认（本地插件包 file: 链接加载链路）**：链路为
`profile package.json dependencies: file:绝对路径` → `pnpm install`（nodeLinker hoisted，链接进
`~/.dsh/profiles/web/node_modules/dsh-genoffice-sidebar`）→ `cordis.patch.yml` insert 行
（`- id: genoffice-sidebar / name: 'dsh-genoffice-sidebar'`）→ profile patch 层**实时生效**
（watchUserPatches + hmr watch-only，无需重启 dsh web）→ 新行挂载 → host loader 导入
`lib/index.js`（node half）→ `dsh-client-modules` 扫描 dshClient 行 → 注入
`window.__DSH_BOOT__` → 浏览器按需 fetch `/plugins/dsh-genoffice-sidebar/client.js?rev=` →
`window.__ModuleLoader__.load({id, factory})` 注册 → 浏览器端 cordis entry 挂载 client apply。

实测证据：
- `curl -s http://127.0.0.1:3080/ | grep -o genoffice-sidebar` → 命中（boot manifest 含该行，plugins=24）
- bundle: `curl http://127.0.0.1:3080/plugins/dsh-genoffice-sidebar/client.js` → 200，含
  `__ModuleLoader__.load({ id: "dsh-genoffice-sidebar", factory: ... })`
- Playwright 打开 GUI：console 出现 `[genoffice-smoke] client bundle loaded`；角标
  `#genoffice-smoke` 可见（smoke-badge.png）；pageErrors 为空
- host 侧 fiber 存在性由 manifest 行存在间接证明（modules service 仅收录有 fiber 的行）

**ASM-002 确认（DSH web 无 frame-src 限制）**：GUI 页面注入 `<iframe src="http://localhost:8787/docs/">`
→ relay 文档请求 200，无 CSP 拦截（iframe.png）。

**ASM-003 前置检查**：`ui-sidebar/src/client/index.ts` 仅导出类型（SidebarRootComponentProps 等），
组件未导出 — 自绘 rail 结论成立。

## Task 2: genoffice 基线回归快照

6 个 e2e 脚本全部通过，console errors: none（baseline.log）：
smoke-test / e2e-open-save / e2e-home / e2e-cross-app / e2e-dragdrop / e2e-url-open — exit=0 全部。

## Task 3: Phase 0 回归验证

- 冒烟面板可见 ✓（gui-full.png）
- e2e-url-open 全绿 ✓（baseline.log）
- console 无新增 error ✓（console.log / pageErrors 空）

## 事实回写（spec §1.3/§1.4）

- ASM-001：确认可行；patch 行实时生效（无需重启），但新增**包**依赖需 pnpm install；client bundle
  内容变更需重新 build（rebuilt 仅 HMR dev 模式）。
- ASM-002：确认无 frame-src 限制。
- ASM-005（pty ws）：待 P5 勘察（host httpServer ws 注册方式）。

## 遗留

- 冒烟角标（#genoffice-smoke）在 :3080 GUI 右下角可见，Task 8/9 被 TabsRoot 取代后移除。

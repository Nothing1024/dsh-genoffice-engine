# Phase 2 — 插件骨架（TabsRoot）summary

Date: 2026-08-10 | Tasks: 8, 9, 10, 11 — 已完成

## Task 8: dsh-plugin 正式包结构

- `dsh-plugin/` 包结构定型：`src/index.ts`（host 侧 node half）、`src/client/index.ts`（client half apply）、
  `src/TabsRoot.tsx` + `TabsRoot.module.css`、`src/store.ts`、`src/slots.ts`（SlotMap merge）、
  `src/contract.ts`（composed props）、`src/tabs/{terminal,genoffice,files}.tsx` 占位、`src/css-modules.d.ts`、README.md
- 构建：tsdown 复用 DSH 源码树的 `clientBundle` preset（`/Users/nothing/.dsh/source/current/packages/client/tsdown.client.ts`），
  产物与官方包同构（`window.__ModuleLoader__.load({id, factory})`，平台模块 external）
- typecheck：tsconfig extends DSH `tsconfig.base.client.json`，`paths` 指向 DSH 构建产物 `lib/types/*.d.ts`
  （92 条映射由生成脚本产出）；`npm run typecheck` 0 error
- `ctx.slots.register` 完整签名已确认并记录：`{name, children, store, inject, locale?, registrant?}` +
  组件四 share props（PropsRuntime & PropsRenderSlots & PropsStore & InjectFace）；`slots.inject(key, cb)`
  等待声明（声明生命周期内生效，collapse 时自动回退）

## Task 9: TabsRoot + 替换 sidebar 注册者（BR-001/002/003, UF-001/006, INV-001）

- `cordis.patch.yml`：`- id: ui-sidebar / disabled: true` + insert `dsh-genoffice-sidebar` 行 —
  经 dump-config 验证组合树正确（ui-sidebar 行带 disabled: true）
- client apply：`ctx.slots.register({name:'sidebar', children:{workspaces, settings, tabs.terminal,
  tabs.genoffice, tabs.files}, store: createTabsStore, inject}, TabsRoot)`；三个 tab 面板经
  `slots.inject('sidebar.tabs.<name>', ...)` 注册（等待 TabsRoot 声明，顺序无关）
- TabsRoot：选项卡栏（工作区|终端|GenOffice|文件，激活高亮）+ 内容区 + 底部设置座；
  折叠态渲染 rail 图标列（点击激活并展开）；未注册子槽位 → tab 隐藏（isTabRegistered 探针）
- 实测（Playwright，:3080 真机）：
  - 四个 tab 全部可达，逐个切换内容正确（工作区=官方浏览器"Workspaces/3 sessions/New Session/搜索框"；
    终端/GenOffice/文件=占位）
  - 官方设置座渲染于底部，点击 Settings → 官方设置面板打开（General/Models/配置文件/权限）
  - console 无 error；无白屏

## Task 10: 激活 tab store 与折叠恢复（BR-003, UF-006）

- `createTabsStore`：`{active: TabId}` + `setActive`；transient（不写 localStorage，刷新回默认，与官方一致）
- 折叠/展开恢复实测：切 GenOffice → 点折叠按钮（新增 aria-label="折叠侧边栏"）→ rail 出现 →
  点 rail GenOffice 图标 → 展开且仍为 GenOffice（collapse-restore.png）
- 渲染异常分支：临时注入 throw（`boundary-test`）→ 框架自身 SlotErrorBoundary 捕获
  （"slot entry crashed in 'sidebar.tabs.files'" console 记录 + 空面板占位），侧边栏与其余 tab 存活；
  实测后已还原并删除自绘 ErrorBoundary（冗余死代码）

## Task 11: Phase 2 回归验证

- 官方工作区：列表渲染（会话可见）、搜索输入框存在（"Search name, keywords..."）、New Session 入口在；
  设置面板逐项可用；四 tab 可达；rail 折叠展开恢复；console 无 error（phase2-final.png）

## 遗留

- 工作区 tab 的会话创建/切换/搜索完整交互留到 Task 22 5.2 矩阵（INV-001 逐项点验），避免干扰用户当前会话。
- 冒烟角标已随 Task 8 移除（新 client apply 不再渲染 badge）。

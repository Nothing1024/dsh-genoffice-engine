# Phase 5 — 终端 tab summary

Date: 2026-08-10 | Tasks: 18, 19, 20 — 已完成

## Task 18: host 侧 pty WebSocket 端点（BR-010, INV-006, ASM-005 实测结论）

`src/index.ts`（host half）：`/api/pty.ws` upgrade 路由（`ctx.httpServer.registerUpgrade`），
loopback Origin 握手校验；消息协议 `{type:'input'|'resize'|'ping'}` ↔
`{type:'output'|'exit'|'error'}`；node-pty spawn shell（cwd 默认主目录，`?cwd=` 可覆盖）；
生命周期：ws close/error → kill pty；30s 无心跳 → 回收（防孤儿）；插件卸载 → 全部销毁。

**ASM-005 结论（回写 spec §1.3）**：DSH `ctx.pty`（dsh-pty + dsh-pty-local）服务是**行/发送导向**
（model 工具用：每会话同时仅一个 send operation + readOutput() delta 轮询），不适配交互式 xterm
（逐键流式 push + 真实进程信号）。按 Task 18 明示的回退路径直接使用 node-pty（库已在 DSH 依赖闭包内，
经 healed profile module fallback 解析）。ws 复用 `ws` 库（DSH closure 内）+
webserver `registerUpgrade` 注册模式（与 dsh-client-connection 的 downlink 同构）。

**部署机制发现（关键）**：web 模式禁用模块 HMR → host 侧 node half 变更无法热更新（Node ESM 缓存）。
绕过：profile 行改用**新包名**（`dsh-genoffice-sidebar-r2` + `DSH_PLUGIN_ID` 构建对应 client bundle id）
→ 新 specifier 强制全新 import → 端点即刻上线，无需重启（实测 GOT-ECHO）。旧行 entry 会泄漏
（loader 按行 id 复用不销毁），client apply 加了重复实例守卫（slot 已被占用则惰性退出）。

独立验证（scripts/host-pty-verify.mjs，stub ctx + 真实 http server）：
- ws 连接 → `echo hello-from-pty` → output 帧含 echo ✓
- `exit` → exit 帧 {code:0} ✓
- evil Origin → 握手拒绝 ✓
- 关闭后无子进程残留 ✓（no-orphan.txt）

## Task 19: client 终端面板（xterm.js）

`src/tabs/terminal.tsx`：xterm@5 + xterm-addon-fit；xterm.css 以 `?raw` 打进 bundle 运行时注入
（tsdown 增加 raw-text 插件，虚拟 id 以 .txt 结尾避开 css-guard）；状态机
disconnected→connecting→connected→closed；连接失败 → 「连接失败 — 自动重连中（第 N 次）」
指数退避 1s/2s/5s；15s ping 心跳；ResizeObserver fit；卸载关闭 ws（host 销毁 pty）。

实测（Playwright 真机 :3080，端点在宿主进程上线后）：
- 提示符渲染（.xterm-rows）✓；点击聚焦后输入 `echo hello-from-terminal` → 回显 ✓（terminal-echo.png）
- `sleep 100` + Ctrl+C → 中断，提示符返回 ✓（terminal-ctrl-c.png）
- `sleep 300` 运行中切到 GenOffice tab → `ps` 中 sleep 归零（会话销毁，INV-006）✓
- 切回终端 → 新会话重建 ✓；`exit` → 「进程已退出」+ 新建会话 ✓（terminal-exit.png）
- 失败分支：端点不可达时「连接失败 + 自动重连」✓（ws-down.png）
- console 无 error ✓

## Task 20: Phase 5 回归验证

终端主路径 + 失败分支（ws 失败重连、切 tab 销毁）✓；`ps` 无残留 ✓；console 无 error ✓。

## 遗留

- 30s 无心跳回收为防御性机制（client 正常 15s ping，不触发）；由构造保证，未单列实测。
- host half 热更新机制（r2 重命名 trick）为开发期手法；最终交付以单行 + 正常重启为准。

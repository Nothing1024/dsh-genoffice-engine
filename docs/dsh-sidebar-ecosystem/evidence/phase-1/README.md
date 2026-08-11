# Phase 1 — relay 配套 summary

Date: 2026-08-10 | Tasks: 4, 5, 6, 7 — 已完成

## Task 4: /api/dir（BR-004 / BR-005 / EVD-006）

`web/server.mjs` `handleApi` 新增 `GET /api/dir?path=` 分支（紧跟 /api/file 分支之后）：

- path 缺省 = `os.homedir()`；`resolve()` 绝对化
- `ALLOW_ABS_PATHS` 为 false 时返回与 /api/file **完全相同**的禁用文案（INV-003 无文案漂移）
- `readdir(path, {withFileTypes:true})` → `{ ok, path, parent, entries:[{name, dir, hidden, symlink, size, mtimeMs, ext}] }`
- 排序：隐藏文件最后；目录在前；按名称 localeCompare
- 符号链接仅标记（`symlink: true`）不追链（Dirent 天然不 follow；symlink 条目不做 stat）
- 不可读/不存在 → `{ok:false, error}`（不抛 500）
- 文件头 API 清单已更新

三态实测（evidence/API-dir/）：
- 正常：`curl "/api/dir?path=/tmp"` → ok:true, entries 437（dir-tmp.json）
- 缺失：`/api/dir?path=/nonexistent-xyz` → ok:false ENOENT（dir-missing.json）
- 禁用：`HOST=0.0.0.0` 无开关 → 禁用错误（regression.log）

## Task 5: CORS loopback 白名单（BR-006 / EVD-007）

`createServer` 回调统一注入（所有响应 + OPTIONS 预检）：

- `^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$` 命中 → 回显 ACAO + Allow-Headers: Content-Type, X-File-Name + Allow-Methods: GET, POST, OPTIONS
- OPTIONS → 204 直接返回
- 非白名单 Origin / 无 Origin → 不加任何 CORS 头（同源行为不变）
- 无 `*` 通配（evidence/API-cors/cors-loopback.txt + cors-foreign.txt）

## Task 6: relay 配套回归（INV-002 / INV-003）

- `node web/e2e-url-open.mjs` 全绿（六形态，errors=none）
- 既有端点结构不变：health / file（绝对路径 200）/ fetch-file（非法 url 400 文案）/ inject（token 发放）— regression.log
- 双配置：loopback 默认允许；HOST=0.0.0.0 无开关禁用，且 /api/file 禁用文案与基线逐字一致

## Task 7: Phase 1 回归验证

- Task 6 全绿 ✓
- /api/dir 三态复跑一致 ✓（regression.log 同一次运行内复跑）

## 遗留

- relay 已用新代码重启（后台任务 bash-9，:8787），后续 Phase 测试继续使用。

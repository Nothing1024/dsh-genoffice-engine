# Phase 6 — 集成验收 summary

Date: 2026-08-10 | Tasks: 21, 22, 23 — 已完成

## Task 21: profile 最终集成与安装固化

- patch 最终形态（`~/.dsh/profiles/web/cordis.patch.yml`）：disable `ui-sidebar` +
  disable `directory-picker`(auto) + insert `genoffice-sidebar-r2`（插件行）+
  `directory-picker-browse`（文件 tab 的 host.listDirectory 需要 browse 能力）
- 安装/卸载/回退已写入 `dsh-plugin/README.md`（含 host half 热更新开发手法：
  新包名 + `DSH_PLUGIN_ID` 构建 + patch flip；client 重复实例守卫说明）
- **回退实测**：patch 置空（保留 `[]` 行 — 纯注释文件不解析）→ 全新实例 :3180 启动 →
  官方单面板侧边栏原样恢复（fallback-official.png）；当前 :3080 运行实例的插件侧不受影响
- **干净启动验证**：回退实例证明从零启动路径可用；插件完整启动在 :3080 持续运行中验证
  （四个 tab + 全部面板 + pty 端点均在线）

## Task 22: 5.2 真实场景全套测试（13 行执行矩阵）

全部 13 行通过（Playwright 真机 :3080 + relay :8787）：

| 行 | 结果 | Evidence |
|---|---|---|
| UF-001 主路径（四 tab 逐一点击） | ✅ 激活高亮、面板正确、console 0 error | UF-001/tabs.png + console.log |
| UF-001 子槽位缺失 | ✅ 移除 files 注册 → 文件 tab 隐藏，其余正常 | UF-001/missing-slot.png |
| UF-001 渲染异常 | ✅ 框架 SlotErrorBoundary 占位不白屏 | UF-001/error-boundary.png |
| UF-002 主路径 | ✅ iframe 渲染 simple.docx；hash 前后一致 | UF-002/preview-docx.png + hash-before-after.txt |
| UF-002 relay 停 | ✅ 中继服务未启动 + 重试恢复 | UF-002/relay-down.png / relay-recovered.png |
| UF-002 类型不支持 | ✅ .xlsx 置灰 + 仅桌面版可用 | UF-002/unsupported.png |
| UF-002 空目录 | ✅ 空目录占位 | UF-002/empty-dir.png |
| UF-003 主路径 | ✅ 新标签完整编辑器 | UF-003/open-new-tab.png |
| UF-004 主路径 | ✅ /tmp 进入/上级/主目录 | UF-004/browse.png |
| UF-004 路径错误 | ✅ 错误提示 + 列表保留 | UF-004/error.png |
| UF-005 主路径 | ✅ echo/Ctrl+C/exit；ps 无残留 | UF-005/echo.png + ps-check.txt |
| UF-005 ws 失败 | ✅ 连接失败 + 自动重连 | UF-005/ws-down.png |
| UF-006 主路径 | ✅ 切 GenOffice→折叠→展开恢复 | UF-006/restore.png |

## Task 23: 全量回归与 evidence 收尾

- genoffice 6 e2e 全绿（smoke/open-save/home/cross-app/dragdrop/url-open exit=0，errors none，
  regression.log）
- 官方功能回归（INV-001）：设置面板打开 ✓、搜索框 ✓、New Session 点击无错 ✓（inv001-session.png）；
  工作区列表/会话可见 ✓
- pty 无残留（ps-check.txt: 0）✓；各 UF 执行 console 无 error ✓
- EVD 清单 2.5 逐项核对：EVD-001~009 全部落盘（phase-0 smoke-console.log/iframe.png、
  API-dir、API-cors、UF-001~006）✓
- `validate_package.py`：0 FAIL / 13 PASS ✓
- tasks.csv 全部 23 条 = 已完成

## 遗留 / 风险

- :3080 运行实例带两个插件行（旧行 + r2 行，旧行 client 由守卫惰性化）——开发期手法残留；
  正式部署用单行 + 重启即可（README 已写明），下次 dsh web 重启自动收敛。
- `dsh-plugin-runtime`、`dsh-plugin-r2` 为热更新辅助目录；`dsh-plugin` 为规范包。
- 30s 无心跳 pty 回收为防御机制，未单列实测（client 15s ping 正常路径已验证）。
- 工作区「新建会话」后 conversation 面板内容依赖模型 key，未深验（官方组件未改动）。

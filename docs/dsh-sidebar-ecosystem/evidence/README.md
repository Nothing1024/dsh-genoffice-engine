# Evidence Directory

本目录用于保存执行和验收证据。没有 evidence，不视为完成。

## 目录结构（与 spec.md 第 5.3 节一致）

```text
evidence/
  phase-0/      # Task 1-3：冒烟插件加载日志、iframe 实测、baseline.log
  phase-1/      # Task 6-7：relay 回归日志
  phase-2/      # Task 8-11：构建日志、选项卡栏截图、console log
  phase-3/      # Task 12-15：GenOffice 面板回归
  phase-4/      # Task 16-17：文件面板回归
  phase-5/      # Task 18-20：终端回归、ps 无残留
  phase-6/      # Task 21-23：install.log、regression.log
  UF-001/       # 选项卡切换：tabs.png / missing-slot.png / error-boundary.png / fallback-official.png
  UF-002/       # GenOffice 预览：list.png / preview-docx.png / relay-down.png / unsupported.png / empty-dir.png / hash-before-after.txt
  UF-003/       # 浏览器打开：open-new-tab.png
  UF-004/       # 文件浏览：browse.png / error.png
  UF-005/       # 终端：echo.png / ctrl-c.png / ws-down.png / ws-echo.log / no-orphan.txt
  UF-006/       # 折叠恢复：restore.png / collapse-restore.png
  API-dir/      # /api/dir 样例：dir-tmp.json / dir-missing.json / regression.log
  API-cors/     # CORS 样例：cors-loopback.txt / cors-foreign.txt
```

## Evidence 命名

- `EVD-xxx` 必须能在 `spec.md` 第 2.5 节中找到（EVD-001~EVD-009）。
- 截图文件名包含 UF 编号和状态：`UF-002-preview-docx.png`。
- API 文件名包含场景：`API-dir-missing.json`。
- 命令输出保存完整命令、时间、结果摘要。

## Phase Summary 模板

```markdown
# Phase {N} Summary

## 完成任务

- Task ...

## 验证命令

| 命令 | 结果 | 日志 |
|---|---|---|

## 用户路径 / API 验证

| UF/API | 结果 | Evidence |
|---|---|---|

## 剩余风险

- ...
```

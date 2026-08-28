# dsh-genoffice-engine

这是 DSH 侧用的魔改 GenOffice 引擎，**不是**官方仓。

魔改目标：**更好的云端调用与 agent 化**——web 端脱离 Electron 跑通、relay（`web/server.mjs`，:8787）暴露文件/预览/inject 等 HTTP 面、控制面 API（`/api/control/*` + SSE 执行器）让 `../plugin` 的 DSH 插件以工具/技能驱动 docx / markdown / xlsx / pptx / pdf 五族编辑器。

| | |
|---|---|
| 本仓 | `Nothing1024/dsh-genoffice-engine`（私仓） |
| 官方上游 | `genspark-ai/genoffice`（本仓 remote 名 `upstream`） |
| 产品插件 | `Nothing1024/dsh-genoffice`（并列目录 `../plugin`） |

仓库约定：与产品仓并列 clone，目录名 `engine/`。当前工作分支：`fork/eat-official-engine`。

状态：**实验性（experimental）· 维护中**。配套插件适配 DSH `@deepseek-ai/dsh@0.1.0-rc.7` + `dsh-better-sidebar@0.13.0`。

## 跑起来（web 版）

```sh
npm install
npm run web        # 构建 shell/docs/markdown 的 web-dist 并启动 relay（127.0.0.1:8787）
# 其余 app 按需：npm run web:build -w @genoffice/sheets|slides|pdf
```

浏览器打开 `http://127.0.0.1:8787/`。文件打开协议（`?open=path:…` / `inject:` / `https://…`）、控制面端点与工具名全表见插件仓 `contracts/`（relay-api.md / control-api.md）。relay 默认仅绑 loopback；对外暴露需显式 `GENOFFICE_WEB_OPEN_PATHS=1` 并自行评估安全边界。

想接入 DSH（侧栏预览 + agent 工具驱动编辑），或想让 AI 助手替你一键装好整套：见插件仓 [`Nothing1024/dsh-genoffice`](https://github.com/Nothing1024/dsh-genoffice) README 的「快速开始」与「让 AI 帮你装」两节。

## 与官方同步

拉官方更新：`git fetch upstream`，再合进工作分支。不要把本仓改动推进官方。License 随上游（Apache-2.0）。

# dsh-genoffice-engine

这是 DSH 侧用的魔改 GenOffice 引擎，**不是**官方仓。

魔改目标：**更好的云端调用与 agent 化**——web 端脱离 Electron 跑通、relay（`web/server.mjs`，:8787）暴露文件/预览/inject 等 HTTP 面、控制面 API（`/api/control/*` + SSE 执行器）让 `../plugin` 的 DSH 插件以工具/技能驱动 docx / markdown / xlsx / pptx / pdf 五族编辑器。

| | |
|---|---|
| 本仓 | `Nothing1024/dsh-genoffice-engine`（私仓） |
| 官方上游 | `genspark-ai/genoffice`（本仓 remote 名 `upstream`） |
| 产品插件 | `Nothing1024/dsh-genoffice`（并列目录 `../plugin`） |

本机约定：与产品仓并列，目录名 `engine/`。当前工作分支：`fork/eat-official-engine`。

拉官方更新：`git fetch upstream`，再合进工作分支。不要把本仓改动推进官方。

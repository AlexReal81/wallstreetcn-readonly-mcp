# 华尔街见闻快讯 MCP｜云端只读插件 MVP

版本：0.1.2（2026-11-16）  
状态：**新闻索引和指定窗口已通过在线调用；v0.1.2 修复单条正文读取，待线上验证。**

## 目标

- ChatGPT 通过 MCP **按需**读取华尔街见闻 **7×24／要闻**频道的新快讯。
- 接口采取**时间窗口＋游标分页**，不依赖关键词检索。
- **先全部发现，后由情报官筛选**。取回记录包含：快讯 ID、北京时间、平台重要度、标题、正文预览、原始链接。
- 只对通过筛选的条目使用 `get_news_by_id(id, datetime_bjt?)` 获取正文；建议同时传入索引中的发布时间，避免从最新页回溯。
- MCP **不做写入、抓取计划或持久化**。ChatGPT 继续通过现有 Google Drive 插件归档；原来的 Google Apps Script 可保留为独立定时备份。

## 文件结构

```text
wallstreetcn-mcp-cloudflare/
├── package.json
├── wrangler.jsonc
├── .gitignore
├── src/
│   ├── index.js          # 3 个 MCP 只读工具，官方 Cloudflare Agents MCP Handler
│   └── wscn.js           # 固定华尔街见闻接口、分页、规范化
└── test/
    └── wscn.test.js     # 模拟翻页／边界／展开正文
```

> 源码基于你 Drive 中的 `wallstreetcn-cli-main` 调用约定编写，不修改该项目。

## 最简全云端部署：GitHub 网页 + Cloudflare Workers Builds

无需在本地运行服务器。部署期间需要登录 GitHub 与 Cloudflare，确认授权。Cloudflare 需要能在自己的构建服务器下载 npm 依赖。

### 1. 在 GitHub 创建代码仓库

1. 打开 https://github.com/new ，创建一个**私有**仓库，例如 `wallstreetcn-readonly-mcp`。
2. 将本项目的文件上传至仓库根目录，保持 `src/` 子目录结构；`test/` 可一并上传。
3. 提交至 `main`。**不要上传任何凭据或密钥。**

### 2. 在 Cloudflare 创建 Worker

1. 打开 https://dash.cloudflare.com/ ，进入 **Workers & Pages → Create application → GitHub**（具体文案以界面为准）。
2. 授权 Cloudflare 访问刚创建的仓库，选中该仓库。
3. **Worker 名称**使用 `wallstreetcn-readonly-mcp`，应与 `wrangler.jsonc` 中的 `name` 一致。
4. **Root directory** 设为仓库根目录 `/`。**Build command** 留空（本项目无需预构建）；**Deploy command** 使用 `npx wrangler deploy`（Cloudflare 默认值）。
5. 选择 **Save and Deploy**，等待显示部署成功。

若构建因 npm 依赖版本冲突报错，先保留构建日志，不要反复随意换包：本 MVP 的第三方 MCP 包未在当前执行环境在线安装验证。

### 3. 验证 Cloudflare 地址

假设部署成功后 Cloudflare 提供：

```text
https://wallstreetcn-readonly-mcp.<你的账户>.workers.dev
```

浏览器打开 `https://wallstreetcn-readonly-mcp.<你的账户>.workers.dev/health`，应看到：

```json
{"status":"ok","name":"WallStreetCN Readonly News MCP","endpoint":"/mcp"}
```

> `/health` 只证明 Worker 已部署，**不能证明连通华尔街见闻**。`/mcp` 不是给浏览器普通 GET 访问的网页。

### 4. 在 ChatGPT 连接插件

1. ChatGPT → **插件 → 添加 → 添加自定义 MCP 服务器**。
2. 名称填写「华尔街见闻快讯」（或喜欢的名称）。
3. **MCP Server URL** 填写真实部署地址加 `/mcp`，例如：`https://wallstreetcn-readonly-mcp.<你的账户>.workers.dev/mcp`。
4. 当前 MVP 为仅供验证的公开只读新闻数据，选择 **No authentication / 无身份验证**，阅读并确认风险提示，然后创建插件。
5. 安装这个私人插件；在新的对话中通过 `@` 选择它（可能需要使用 Work，实际能否在普通 Chat 调用要验证）。

### 5. 联调三个工具

**测试 A：真实新闻源**

> 调用 `probe_news_source`，返回华尔街见闻最新三条要闻，包含北京时间和 ID。

**测试 B：时间窗口**

> 调用 `get_news_window_index`，开始 `2026-11-14 19:00:00`，结束 `2026-11-15 19:00:00`，分页读取直到 `complete=true`，报告总条数、分页与异常。不得作关键词或重要度过滤。

该历史窗口在你原 Apps Script 的真实测试中返回过 **35 条 / 6页**。两侧的结果应接近；若不同，应检查时间、可见范围、删改与历史页，不预设哪个一定正确。

**测试 C：完整正文**

> 使用 B 返回的某个 ID 调用 `get_news_by_id`，检查 `content_more` 展开正文是否合并。

通过以上测试，才把 MCP 标记为“可用”。

## MCP 工具说明

### `probe_news_source()`

只请求第一页，返回最新几条新闻、接口状态和游标可用性。

### `get_news_window_index(start, end, next_cursor?, pages_per_call?)`

- `start` / `end`：北京时间完整秒级时间，左闭右开，形如 `2026-11-15 19:00:00`。
- 仅接受**已结束**的窗口，单次窗口最长 7 天。
- 每次工具调用最多 8 页；默认 6 页，每页最多 50 条原始新闻。
- 返回 `items`、`batch_count`、`complete`、`next_cursor`、`pages_read` 等。
- 当 `complete=false` 时，必须用相同 `start/end` 和返回的 `next_cursor` 继续调用，直到 `complete=true`；**不能把部分批次当作完整日报**。
- 不用关键词、重要度过滤；原始正文按需另查，不向 Chat 注入海量全文。

### `get_news_by_id(id)`

只接受来自索引的数字 ID，从华尔街见闻单条快讯接口读取，包括展开部分、关联文章与配图引用。

## 重要边界

1. 华尔街见闻目前使用的是**未经官方承诺稳定性的内部前端接口**。接口字段、频控、地理访问限制可能变化，遇到 403/429 等错误应停止、检查，不绕过身份验证或封禁。
2. **接口遍历到窗口起点 ≠ 绝对保证平台历史数据无缺漏**。需要 App 抽样对照，尤其是在迟发、修改、撤稿的情况下。
3. 当前未连接数据库，MCP 不能自动知道“上次19:00的采集检查点”。情报官可从 Drive 读取上次成功窗口，也可以显式指定时间窗口；若要做到严格的「一句话从上次位置开始」，需在运行规则里明确读取哪个检查点。
4. **无身份验证**是最简联调方案，任何知道 URL 的人都能请求公开新闻，可能消耗 Worker 配额。服务端已将访问限制在华尔街见闻固定域名、固定频道、有限时间跨度和页数。正式长期运行建议加 OAuth/Cloudflare Access、访问限额，并评估来源网站的使用条件。
5. 按 Cloudflare 2026-11 文档，Workers Free 每次调用最多约 50 个外部子请求，代码将单次批量分页限制在 8 页，避免一次调用大量消耗。
6. 使用 ChatGPT 的最终模式（普通 Chat / Work）及当前账号的插件权限需在安装后实际验证；勿提前承诺所有会话都能自动执行。

## 当前实际验收状态

| 环节 | 状态 |
| --- | --- |
| 用户的 Google Apps Script → 华尔街见闻真实接口 | 已通过（50条实时消息） |
| Google Apps Script → 历史窗口游标翻页 | 已通过（35条，6页） |
| 本 MCP 的本地纯逻辑测试 | 已通过（4组测试） |
| Cloudflare Workers 构建 / 线上服务 | **尚未部署** |
| Cloudflare → 华尔街见闻 | **尚未验证** |
| ChatGPT 自定义插件 → MCP 工具调用 | **尚未验证** |
| Chat 情报官筛选 → Drive 归档 | **尚未端到端验收** |

## 参考

- https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://github.com/InphinitiZ/wallstreetcn-cli


## v0.1.2 正文检索修复

`get_news_by_id` 不再使用可能返回空对象的单条详情接口，改用已验收的列表接口，从时间戳游标开始定向查找 ID，并合并 `content` 和 `content_more` 输出到 `body_text`。请求旧新闻推荐传 `datetime_bjt`。已通过本地模拟测试，线上全文验收仍需进行。

# llmproxy

一个单端口的 LLM 网关：把多个 OpenAI 兼容上游（OpenAI、DeepSeek、Ollama 等）聚合成统一的 OpenAI 与 Ollama 兼容入口，支持模型别名、负载均衡、会话亲和路由、顺序回退、API 统计与内置管理界面。

A single-port LLM gateway that aggregates multiple OpenAI-compatible upstreams (OpenAI, DeepSeek, Ollama, ...) behind unified OpenAI- and Ollama-compatible endpoints, with model aliases, round-robin load balancing, session-affinity routing, sequential failover, request stats, and a built-in admin UI.

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Build the admin UI (web)
pnpm --filter @llmproxy/web build

# 3. Start the server (single port, default 0.0.0.0:3000; local access via http://127.0.0.1:3000)
pnpm start
```

> `pnpm start` smart-builds: it only builds what's missing (`server/dist` or `web/dist`); with artifacts present it runs `node server/dist/index.js` directly without recompiling the frontend. Force a full rebuild first with `pnpm start:rebuild`; build explicitly with `pnpm build`.
> Override the port / host with `--host` / `--port` flags (they pass through to the server process), e.g. `pnpm start -- --host 0.0.0.0 --port 8080` or `node scripts/start.js --host 0.0.0.0 --port 8080`.

Smoke-test the OpenAI-compatible endpoint (returns an OpenAI-style `choices` payload):

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}]}'
```

Smoke-test the Ollama-compatible endpoint (returns an Ollama-style `message` payload):

```bash
curl http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}], "stream": false}'
```

Both endpoints stream when `"stream": true` is set (SSE `data:` lines for OpenAI, NDJSON for Ollama).

## Config

The configuration lives in a JSONC file (comments and trailing commas allowed) at:

```
<userHome>/llmproxy/llmproxy.jsonc
```

On Windows `<userHome>` is `%USERPROFILE%` (e.g. `C:\Users\<you>\llmproxy\llmproxy.jsonc`); on POSIX it is `$HOME`. The file is created on first run with `0600` permissions. Edits are hot-reloaded by a file watcher — no restart needed. A failed reload never blocks startup and surfaces as a warning in the admin UI and logs.

Schema reference — see `server/src/config/schema.ts` for the authoritative Zod definitions. Shape:

| Field | Type | Description |
| --- | --- | --- |
| `upstreams[]` | array (min 1) | OpenAI-compatible upstream providers |
| `upstreams[].id` | string | unique id referenced by candidates |
| `upstreams[].baseUrl` | URL string | upstream base URL, e.g. `https://api.openai.com/v1` |
| `upstreams[].apiKey` | string | plaintext key (stored 0600 in the config file) |
| `upstreams[].timeoutMs` | number | request timeout in ms, default `30000` |
| `upstreams[].disabled` | boolean | pause switch, default `false` |
| `downstreamModels` | record | alias → ordered candidate list (min 1 each) |
| `downstreamModels[alias][].upstreamId` | string | must match an `upstreams[].id` |
| `downstreamModels[alias][].model` | string | model name used on the upstream side |
| `routing` | object (optional) | routing behavior config, currently session affinity |
| `routing.sessionAffinity` | object | session-affinity routing; omitted = defaults |
| `routing.sessionAffinity.enabled` | boolean | master switch, default `true` |
| `routing.sessionAffinity.cleanupMaxAgeMs` | number | session retention period, default `604800000` (1 week); `0` = never expire |
| `routing.sessionAffinity.cleanupIntervalMs` | number | auto-cleanup interval, default `3600000` (1 hour); `0` = disable auto cleanup |

Example:

```jsonc
{
  // 上游：OpenAI 兼容服务
  "upstreams": [
    { "id": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "timeoutMs": 30000 },
    { "id": "ollama-local", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "dummy" }
  ],
  // 下游别名 → 有序候选（按顺序尝试，失败自动切换到下一个）
  "downstreamModels": {
    "my-alias": [
      { "upstreamId": "openai", "model": "gpt-4o-mini" },
      { "upstreamId": "ollama-local", "model": "qwen2.5:7b" }
    ]
  },
  // 路由行为（可选；省略时启用默认值）：同一会话粘附到同一上游，最大化 prompt cache 复用
  "routing": {
    "sessionAffinity": {
      "enabled": true,              // 总开关，默认 true
      "cleanupMaxAgeMs": 604800000, // 会话保留期，默认 1 周；0 = 永不过期
      "cleanupIntervalMs": 3600000  // 自动清理周期，默认 1 小时；0 = 关闭自动清理
    }
  }
}
```

## 使用说明 Usage Guide

### 首次启动 First Run

1. **安装依赖**：`pnpm install`（需要 Node ≥ 18 与 pnpm 9.x，见下文「开发说明」）
2. **构建管理端**：`pnpm --filter @llmproxy/web build`，或直接执行 `pnpm start`（产物缺失时启动前自动构建 web）
3. **启动服务**：`pnpm start`，默认监听 `0.0.0.0:3000`（本机访问 `http://127.0.0.1:3000`）；可用命令行参数覆盖：`pnpm start -- --host 0.0.0.0 --port 8080`（或 `node scripts/start.js --host 0.0.0.0 --port 8080`，`--host=0.0.0.0` / `--port=8080` 等号形式亦可）
4. **配置文件自动生成**：首次启动会在 `<userHome>/llmproxy/llmproxy.jsonc` 生成一份带注释的示例配置（Windows 为 `C:\Users\<you>\llmproxy\llmproxy.jsonc`，POSIX 为 `$HOME/llmproxy/llmproxy.jsonc`，权限 `0600`）。示例中的 `apiKey` 默认是 `sk-REPLACE_ME`，请替换成真实密钥。改完保存即被热重载，无需重启
5. **浏览器访问**：打开 `http://127.0.0.1:3000` 进入管理界面（管理端与各 API 共用同一端口）。可用 Quickstart 章节的两个 curl 做冒烟测试

### 管理界面 Management UI

管理端是 Vue 3 + Element Plus 单页应用，挂在 `/` 路径。左侧导航共 6 个页面，所有操作都通过 `/admin/api` 接口并立即生效（配置类操作落到配置文件，会话粘附与日志查询落到 SQLite）。

#### Dashboard

4 张指标卡片，每 30 秒自动刷新，也可点 Refresh 手动刷新：

| 卡片 | 含义 |
| --- | --- |
| Active Upstreams | 当前启用中的上游数量（`disabled` 为 true 的不计入） |
| Total Models | 下游模型别名总数（`downstreamModels` 的键个数） |
| Requests (since process start) | 进程启动以来累计的请求次数（每次上游尝试计 1 次，含回退重试；重启清零） |
| Error Rate (since process start) | 错误占比 `errors / requests × 100%`；尚无请求时显示 `—` |

卡片副标题的 `since <时间>` 是统计窗口起点（即进程启动时刻），与 Stats 页口径一致。

#### Upstreams（上游管理）

表格列出全部上游：ID、Base URL、Type（固定 `openai`）、Status（`Healthy` / `Paused`）、Disabled（是/否）。**被暂停的行灰底显示并带 `Paused` 标签**，不会被隐藏。

- **新增**：点「新增上游」，填写 ID（唯一）、Base URL（合法 URL）、API Key（新增时必填）、超时（ms，默认 30000）、是否暂停
- **编辑**：点「编辑」。编辑模式下 ID 不可修改；**API Key 输入框留空表示「保持原密钥不变」**，仅当非空时才会上传覆盖（避免掩码值覆盖明文）
- **暂停 / 恢复**：点「暂停」或「恢复」只切换 `disabled` 字段，暂停后的上游不再参与路由
- **测试**：点「测试」调用 `POST /admin/api/upstreams/:id/test`，弹窗展示状态（成功/失败）、延迟（ms）、HTTP 状态码、模型数，失败时附错误码（如 `ECONNREFUSED`）
- **删除**：点「删除」需二次确认。删除后所有模型别名中引用该上游的候选会被级联清理（候选被清空的别名整体删除）；**最后一个上游不允许删除**

#### Models（模型别名）

每个别名是一个折叠面板，别名内是**有序候选列表**（按顺序尝试，失败自动切下一个）：

- **新增别名**：点「新增别名」输入名称，要求非空且不得与已有别名重复
- **新增 / 删除候选**：面板内「新增候选」追加一行（默认选第一个上游），行末垃圾桶按钮删除当前候选
- **拖拽排序**：按住行首手柄拖动调整候选顺序，拖拽结束时立即重排
- **保存**：页面不会自动保存，改完必须点右下角「保存」。保存是 **PUT 全量替换**（`PUT /admin/api/downstream-models`），提交前校验：至少一个别名、每个别名至少一个候选、每个候选的上游与模型名均已填写

> 注意：保存是全量覆盖语义，页面上没显示的旧别名会在保存后被一并清除。

#### Logs（日志）

顶部四个筛选条件，变更后防抖 300ms 自动拉取，页面每 5 秒自动刷新（浏览历史日志时暂停自动刷新）：

- **类型**：App 日志 / API 日志 切换（对应 `type=app|api`）
- **日期**：必填，默认今天，格式 `YYYY-MM-DD`
- **级别**：`all` / trace / debug / info / warn / error / fatal。**级别是阈值语义**：选 `info` 显示 info 及以上（info/warn/error/fatal）；选 `all` 时前端显式传 `trace` 以包含全部级别（后端缺省阈值是 info）
- **关键词**：对消息内容做子串匹配，**大小写敏感**（后端同时匹配 msg / url / request_id / category）

表格列：Time、Level（彩色标签）、App 日志显示 Category、API 日志显示 Request ID（前 8 位）、Message（请求完成行会附带 `method url -> status`）。

查询**直接读 SQLite**（`llmproxy.db` 的 `logs` 表，见「日志存储」），不再反向读取日志文件。分页由后端完成：`offset` / `limit` 游标分页（limit 默认 100、上限 500），按时间倒序（最新在前），返回 `hasMore` 标记是否还有更早记录；前端「加载更早」把 offset 后移翻页，「回到最新」重置 offset=0。

#### Stats（统计）

顶部 3 个 KPI + 一张按上游聚合的明细表，每 30 秒自动刷新：

| KPI | 含义 |
| --- | --- |
| Total Requests | 进程启动以来总请求数 |
| Total Errors | 失败尝试总数 |
| Avg Latency (ms) | 平均延迟，保留 2 位小数 |

明细表按上游 ID 列出 Requests / Errors / Avg Latency (ms)。副标题「Counters reset on restart」即计数器在进程重启后清零（纯内存，不落盘）。

#### Sessions（会话）

可视化会话亲和映射（见「路由与回退行为」下的会话亲和路由）：表格列出 Session Key、下游别名、粘附上游、上游模型、客户端、创建 / 更新时间，按更新时间倒序，每 5 秒自动刷新，支持分页与按客户端 / 关键词过滤：

- **解绑**：点「解绑」调用 `DELETE /admin/api/sessions/:sessionKey`，该会话下次请求重新选上游
- **清空全部**：调用 `DELETE /admin/api/sessions`，删除全部粘附映射
- **立即清理**：调用 `POST /admin/api/sessions/cleanup`，立即执行一次过期清理（受 `cleanupMaxAgeMs` 约束）

### 客户端接入 Client Integration

网关对外提供两套兼容接口：OpenAI 风格（`/v1`）与 Ollama 风格（`/api`）。请求里的 `model` 一律填**下游别名**（不是上游真实模型名）。

#### OpenAI 客户端

任意支持自定义 `baseURL` 的 OpenAI SDK 均可直连 `/v1`：

```ts
// openai SDK
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1', // 指向网关
  apiKey: 'anything',                  // 网关不校验客户端密钥（鉴权用配置里的上游 apiKey）
})

const res = await client.chat.completions.create({
  model: 'my-alias', // 下游别名
  messages: [{ role: 'user', content: 'hi' }],
})
```

直接 HTTP（非流式）：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}]}'
```

#### Ollama 客户端

把网关地址配到 `OLLAMA_HOST`，Ollama 生态（CLI、各类基于 Ollama 的客户端）即可透明接入：

```bash
# 环境变量指向网关（把默认的 11434 换成网关端口）
export OLLAMA_HOST=http://127.0.0.1:3000

# ollama list 命中 GET /api/tags（列出下游模型别名）
ollama list

# ollama run 命中 POST /api/chat（model 用下游别名）
ollama run my-alias
```

ollama-js SDK：

```ts
import { Ollama } from 'ollama'

const ollama = new Ollama({ host: 'http://127.0.0.1:3000' })
const res = await ollama.chat({
  model: 'my-alias', // 下游别名
  messages: [{ role: 'user', content: 'hi' }],
})
```

> 限制：网关只实现了 Ollama 的 `/api/chat`、`/api/tags` 与 `/api/version`；`/api/generate`、`/api/embed`、`/api/show` 等未实现。`n > 1` 在 `/api/chat` 上会被拒绝（400）。

#### 流式调用 Streaming

两个端点都支持 `"stream": true`，OpenAI 端点输出 SSE，Ollama 端点输出 NDJSON：

```bash
# OpenAI 风格：SSE，data: 块 + 末尾 data: [DONE]
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}], "stream": true}'
```

```bash
# Ollama 风格：NDJSON，每行一个 JSON（最后一行 done: true 收尾）
curl -N http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}], "stream": true}'
```

### 路由与回退行为 Routing & Failover

- **轮询（round-robin）**：每个下游别名维护独立计数器，新请求按 `count % 候选数` 选起点，请求间轮流分配
- **顺序回退**：从轮询选出的起点开始按候选顺序逐个尝试，某个候选失败且**可回退**时自动切下一个
- **触发回退的条件**：上游网络错误（`ECONNREFUSED` / `ETIMEDOUT` / `ECONNRESET` / `ENOTFOUND`）、上游请求超时、HTTP `429`、HTTP `5xx`
- **不触发回退的条件**：其它 4xx（如 `401` / `403` / `404`，鉴权类问题换上游没有意义），立即中断并把该错误返回给客户端
- **全部失败**：返回 `502 {"error": "no_upstream"}`（附最后一次尝试的错误码）
- **暂停的上游**（`disabled: true`）不参与路由，其候选在解析时被过滤；若某别名所有候选都被暂停，则按原列表返回并记警告，交由回退逻辑处理

#### 会话亲和路由 Session Affinity

会话亲和路由把**同一会话的请求粘附到同一上游**，最大化 LLM 的 prompt cache 利用率：同一段上下文反复命中同一上游，缓存命中率更高，首 token 延迟与成本都更低。

**会话键来源**（优先级从高到低）：

1. **HTTP header `X-OpenWebUI-Chat-Id`**：Open WebUI 专有头，值为聊天会话 UUID，命中即作为会话键
2. **内容前缀哈希**：取请求体 `messages` 前 2 条（通常 system + 首条 user 消息）的 `role + content`，`sha256` 后作为会话键。无需 client 配合，相同前缀的请求自动汇聚到同一上游
3. **两者都取不到**：回退原有轮询（round-robin），行为与旧版本一致

**粘附映射持久化**在 SQLite：`<userHome>/llmproxy/llmproxy.db`，表 `sessions`（`session_key` / `session_id` / `client` / `downstream_model` / `upstream_id` / `upstream_model` / `created_at` / `updated_at`）。

**粘附规则**：

- 首次请求选定上游后固定，后续同会话请求不再参与轮询
- 粘附的上游被**禁用 / 删除**时自动重新选择上游
- 粘附的上游请求失败并**回退到其它上游成功**后，自动改绑到成功上游（绑定跟随实际可用性）

**已知限制**：

- 无会话键的请求（如 opencode 等不传会话标识的 client）走轮询，不享受会话亲和
- 不同会话若内容前缀相同会粘到同一上游，这不影响正确性，反而最大化 cache 复用
- 会话首条消息被编辑会导致内容哈希变化，视为新会话（会重新选上游）

### 管理 API 快速参考 Admin API Reference

所有管理端点位于 `/admin/api`，返回 JSON；无鉴权（由部署层防护），请在可信网络内使用。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/admin/api/health` | 健康检查：`status` / `uptime` / `version` / 各上游 `healthy` 或 `paused` |
| GET | `/admin/api/upstreams` | 上游列表（apiKey 已掩码） |
| POST | `/admin/api/upstreams` | 新增上游（重复 ID 返回 400 `duplicate_id`） |
| PUT | `/admin/api/upstreams/:id` | 部分更新上游（ID 以路径为准；apiKey 留空保持原值） |
| DELETE | `/admin/api/upstreams/:id` | 删除上游（级联清理候选；最后一个上游拒绝删除） |
| POST | `/admin/api/upstreams/:id/test` | 连通性测试（可用 body 覆盖 baseUrl / apiKey） |
| GET | `/admin/api/downstream-models` | 查看别名 → 候选映射 |
| PUT | `/admin/api/downstream-models` | 全量替换映射（每个别名至少 1 个候选） |
| GET | `/admin/api/logs` | 日志查询（走 SQLite）：`?type=app|api&date=YYYY-MM-DD&level=info&keyword=xx&offset=0&limit=100`，返回 `lines` / `hasMore` |
| GET | `/admin/api/stats` | 统计：`since` / `totals` / `perUpstream` |
| GET | `/admin/api/config` | 当前生效配置（apiKey 已掩码） |
| GET | `/admin/api/config/reload-error` | 最近一次配置重载错误（无则 `null`） |
| GET | `/admin/api/sessions` | 会话粘附分页列表：`?offset&limit&client&keyword`（updated_at 倒序） |
| DELETE | `/admin/api/sessions/:sessionKey` | 解绑单条会话（下次请求重新选上游） |
| DELETE | `/admin/api/sessions` | 清空全部会话粘附映射 |
| POST | `/admin/api/sessions/cleanup` | 立即执行一次过期清理 |

常用 curl 示例：

```bash
# 查看上游列表
curl http://127.0.0.1:3000/admin/api/upstreams

# 新增上游
curl -X POST http://127.0.0.1:3000/admin/api/upstreams \
  -H 'Content-Type: application/json' \
  -d '{"id": "deepseek", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-xxx", "timeoutMs": 60000}'

# 暂停 / 恢复上游（只下发 disabled 字段）
curl -X PUT http://127.0.0.1:3000/admin/api/upstreams/deepseek \
  -H 'Content-Type: application/json' \
  -d '{"disabled": true}'

# 删除上游
curl -X DELETE http://127.0.0.1:3000/admin/api/upstreams/deepseek

# 连通性测试
curl -X POST http://127.0.0.1:3000/admin/api/upstreams/openai-main/test

# 查询日志（走 SQLite；type 区分 app/api，阈值 info，关键词 "error"）
curl 'http://127.0.0.1:3000/admin/api/logs?type=app&date=2026-08-02&level=info&keyword=error'

# 统计与重载错误
curl http://127.0.0.1:3000/admin/api/stats
curl http://127.0.0.1:3000/admin/api/config/reload-error
```

## Protocol Support Matrix

All routes are served on the single port (default `3000`).

| Endpoint | Supported | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | ✅ | OpenAI-compatible chat; passthrough to upstream with alias routing; streaming SSE when `stream: true` |
| `POST /v1/responses` | ✅ | OpenAI Responses API; converted to/from Chat Completions at the gateway boundary; non-streaming returns an `object: "response"` payload, `stream: true` returns a Responses SSE event stream |
| `GET /v1/models` | ✅ | OpenAI-compatible model list (returns downstream model aliases) |
| `POST /api/chat` | ✅ | Ollama-compatible chat; request/response converted to/from the OpenAI upstream format; NDJSON streaming |
| `GET /api/tags` | ✅ | Ollama-compatible model list |
| `GET /api/version` | ✅ | Ollama-compatible version probe (returns `0.5.12`) |
| `GET /admin/api/health` | ✅ | health check |
| `GET /admin/api/stats` | ✅ | per-alias attempt counters (60s snapshot) |
| `GET /admin/api/upstreams` · `POST` · `PUT /:id` · `DELETE /:id` · `POST /:id/test` | ✅ | upstream CRUD + connectivity test |
| `GET /admin/api/downstream-models` · `PUT` | ✅ | alias/candidate management |
| `GET /admin/api/logs` | ✅ | log lines served from SQLite (type/level/time/keyword filters, offset/limit pagination, `hasMore`) |
| `GET /admin/api/config` · `GET /admin/api/config/reload-error` | ✅ | config inspection + last reload error |
| `GET /admin/api/sessions` · `DELETE /:sessionKey` · `DELETE` · `POST /cleanup` | ✅ | session-affinity mapping: list, unbind, clear-all, cleanup |
| `/` (web UI) | ✅ | built admin SPA (requires `web/dist`, otherwise `503`) |

Limitations: tool calls are stripped from upstream responses on the Ollama path (warned + dropped); `n > 1` is rejected with `400` on the Ollama path.

## Architecture

The gateway is a single Node.js/Express process composed of three layers: a **gateway core** (config store + file watcher, model-alias router, round-robin load balancer, session-affinity routing with SQLite persistence, sequential failover, stats counter, log4js request logger dual-written to files and SQLite), **protocol adapters** (OpenAI-compatible and Ollama-compatible downstream routes plus OpenAI-compatible upstream clients, with dedicated converters for OpenAI ↔ Ollama request/response/stream shapes and Responses ↔ Chat Completions conversion at the gateway boundary), and an **admin UI** (Vue 3 + Element Plus SPA served from the same port, managing upstreams, aliases, sessions, logs and stats through `/admin/api`). Upstream clients and the router rebuild on config change so edits apply without restart; every request is routed through the ordered candidate list with automatic failover to the next healthy upstream.

## Protocol Conversion

The `/api/chat` endpoint converts between Ollama and OpenAI formats. Key field mappings:

**Ollama request → upstream (OpenAI-shaped) request:**

| Ollama | Upstream (OpenAI) |
| --- | --- |
| `model` (alias) | `model` (candidate model name) |
| `messages[].role/content` | `messages[].role/content` |
| `stream` | `stream` |
| `options.temperature / top_p / stop / seed / num_predict` | top-level `temperature / top_p / stop / seed / max_tokens` |
| `format` | `response_format` |
| `images[]` | image content parts |

**Upstream (OpenAI) response → Ollama response:**

| Upstream (OpenAI) | Ollama |
| --- | --- |
| `choices[0].message.role/content` | `message.role/content` |
| `choices[0].finish_reason` | `done_reason` (`stop` / `length`) |
| `created` (unix seconds) | `created_at` (ISO 8601) |
| `usage.prompt_tokens` | `prompt_eval_count` |
| `usage.completion_tokens` | `eval_count` |
| `choices[0].message.tool_calls` | dropped (warned; tool calls are not forwarded) |

Example — client sends an OpenAI-style request and receives an Ollama-style response:

```jsonc
// Request  (POST /api/chat, alias "my-alias" -> upstream model "gpt-4o-mini")
{ "model": "my-alias", "messages": [{ "role": "user", "content": "hi" }], "stream": false }
```

```jsonc
// Response (converted from the OpenAI upstream response)
{
  "model": "my-alias",
  "created_at": "2026-08-02T06:00:00.000Z",
  "message": { "role": "assistant", "content": "Hello!" },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 12,
  "eval_count": 5
}
```

The `/v1/chat/completions` endpoint is passthrough: requests go to the upstream unchanged (except model alias substitution), and upstream responses are relayed as-is, so `created` stays a unix timestamp there.

## Logging

日志**双写**：每条约目同时写入按日轮转的日志文件与 SQLite，两条链路互相独立（DB 写入失败只降级、绝不影响业务与文件日志）：

- **文件**：`<userHome>/llmproxy/logs/app-YYYY-MM-DD.log`（文本格式）与 `api-YYYY-MM-DD.log`（JSON 行格式，兼容原 pino 契约），按本地日历日轮转（log4js dateFile）。每个请求带 `requestId`，完成后记录 method / URL / status / duration
- **SQLite**：`<userHome>/llmproxy/llmproxy.db` 的 `logs` 表（与 `sessions` 表共存于同一 DB 文件）。写入走统一包装：`getLogger()` 与 API 请求日志经 `setLogStore` 注入的双写包装自动落库，业务代码零改动
- **表结构**：`logs` 表（id / type / level / time / msg / category / request_id / method / url / status / duration_ms / raw）；`raw` 列保存完整原始 JSON（含 headers，已脱敏：`authorization` / `x-api-key` 永不落库，任意嵌套层级剔除）
- **保留期**：文件与 DB 完全一致。文件按 mtime 清理超过 5 天的 `app-*.log` / `api-*.log`；DB 执行 `DELETE FROM logs WHERE time < now - 5天`。两者均在启动时清理一次 + 每 6 小时清理一次（文件见 `server/src/logger/sweep.ts`，DB 见 `server/src/logstore/index.ts`，调度装配见 `server/src/server/index.ts`）

服务日志写文件而非 stdout，排查启动问题时看 `logs/` 下的当日日志（如 "ready on" 消息）；管理端日志查询走 SQLite（见「管理界面 → Logs」），不依赖日志文件。

## API Key Behavior

1. **MUST NOT** be logged: api keys never appear in request/response logs (the file side filters the sensitive headers; the SQLite side strips `authorization` / `x-api-key` at any nesting depth as defense in depth)
2. **MUST NOT** be forwarded from the request — the gateway never reads a client-supplied `Authorization` header to reach upstreams; upstream auth always comes from the configured `apiKey`
3. **MUST NOT** be shown in cleartext in the admin UI — the API returns a masked value (e.g. `sk-****`), and an empty key on edit means "keep the existing one"
4. **MUST NOT** be echoed back — no API response, error body, or admin endpoint echoes the stored key
5. **MUST NOT** be displayed in cleartext anywhere in the UI — only the masked form is ever rendered

## 部署注意事项 Deployment Notes

**会话亲和路由**（功能说明见「使用说明」中的「会话亲和路由 Session Affinity」）：

- **Open WebUI 需开启** `ENABLE_FORWARD_USER_INFO_HEADERS=true`（环境变量），否则 Open WebUI 不会发送 `X-OpenWebUI-Chat-Id` header，只能走内容前缀哈希兜底（仍可用，只是亲和精度略低）
- Open WebUI 的 header 名可自定义：`FORWARD_SESSION_INFO_HEADER_CHAT_ID`（默认 `X-OpenWebUI-Chat-Id`）
- **SQLite 依赖**：better-sqlite3（Node 14+ 兼容）。DB 文件与配置文件同目录 `<userHome>/llmproxy/llmproxy.db`，内含 `sessions`（会话粘附）与 `logs`（日志双写）两张表；WAL 模式，多连接并发读写互不阻塞

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `EADDRINUSE` / port already taken on startup | another process holds `3000` (or the port from `--port` / the `server` config). Stop it or start with `--port <free-port>` |
| Web UI returns `503 { "error": "admin_ui_not_built" }` | `web/dist` is missing (fresh checkout). Run `pnpm --filter @llmproxy/web build` (or `pnpm start`) |
| Requests fail with 404 / unknown model | the alias in `model` is not defined in `downstreamModels`; check the config file and the admin UI Models page |
| Upstream unreachable → 502, then failover | verify `baseUrl` reachability (`POST /admin/api/upstreams/:id/test`), `apiKey`, and per-upstream `timeoutMs` |
| Config edit "does nothing" | check `<userHome>/llmproxy/llmproxy.jsonc` is valid JSONC and the watcher reload succeeded (see `GET /admin/api/config/reload-error`) |
| `GET /api/tags` or `/v1/models` stale | the model list returns downstream aliases directly from config (no caching); check the config file to ensure expected aliases are present |
| Logs not on stdout | expected: logs are written to `<userHome>/llmproxy/logs/app-YYYY-MM-DD.log` and dual-written to SQLite (admin queries read the DB) |
| Open WebUI 会话未粘附到同一上游 | 确认已设置 `ENABLE_FORWARD_USER_INFO_HEADERS=true` 并重启 Open WebUI（见「部署注意事项」）；未开启时仅内容前缀哈希生效 |

## Development 开发说明

### 环境要求 Prerequisites

- **Node.js ≥ 18**：根 `package.json` 的 `engines` 约束，服务端目标 ES2022
- **pnpm 9.x**：仓库固定 `packageManager: "pnpm@9.15.4"`。推荐用 corepack 启用：`corepack enable`；已有 pnpm 的直接 `npm i -g pnpm@9` 对齐版本

### 仓库结构 Repository Layout

pnpm workspace 包含两个包：`server`（Node.js/Express 5 服务端）与 `web`（Vue 3 管理端）。根 `package.json` 只提供统一脚本，不含业务代码。

```text
llmproxy/
├── package.json            # 工作区根：dev / start / start:rebuild / build / test / lint / typecheck
├── server/                 # @llmproxy/server：Express 5 + TypeScript ESM
│   ├── package.json
│   ├── tsconfig.json       # strict + NodeNext（.js 后缀导入）
│   └── src/
│       ├── index.ts        # 进程入口：调用 startServer()
│       ├── paths.ts        # 数据目录 / 配置文件 / 日志路径推导（<homedir>/llmproxy）
│       ├── config/         # schema(zod) / loader(JSONC) / store(原子写+去重) / watcher(防抖)
│       ├── router/         # index(别名→候选) / load-balancer(轮询) / fallback(顺序回退) / errors
│       ├── upstream/       # openai.ts：OpenAI 兼容上游客户端（axios 流式 + abort + connectError）
│       ├── converters/     # OpenAI ↔ Ollama 请求 / 响应 / 流 / 模型列表转换 + Responses ↔ Chat 边界转换
│       ├── server/         # openai.ts / ollama.ts / admin.ts 三个路由模块 + index.ts 单端口装配（含 listen.ts 监听解析）
│       ├── logger/         # index.ts（log4js 双写：文件 + SQLite）+ sweep.ts（文件保留期清理）
│       ├── logstore/       # index.ts：LogStore（SQLite 落库 / 查询 / 清理，logs 表）
│       └── stats/          # counter.ts：进程内计数器
└── web/                    # @llmproxy/web：Vue 3 + Element Plus 管理端 SPA
    ├── package.json
    ├── vite.config.ts      # dev server 5173 + /admin/api 代理到 127.0.0.1:3000
    ├── index.html
    └── src/
        ├── main.ts         # 应用入口（Pinia + Router + Element Plus）
        ├── router.ts       # 路由表（AdminLayout 下的 6 个页面）
        ├── api/client.ts   # axios 实例，baseURL 固定 /admin/api
        ├── layouts/AdminLayout.vue   # 侧边导航 + 主内容区
        └── views/          # Dashboard / Upstreams / Models / Sessions / Logs / Stats
```

### 常用命令 Commands

根目录统一脚本（`pnpm -r` 递归执行到两个子包）：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式：concurrently 同时启动 server 与 web。server 用 `tsx watch` 跑在 `3000`，web 用 Vite 跑在 `5173`，`/admin/api` 请求由 Vite 代理到 `127.0.0.1:3000`。开发期访问管理界面走 `http://127.0.0.1:5173`，直接调 `/v1` `/api` 走 `3000` |
| `pnpm test` | 全部工作区单测（vitest run） |
| `pnpm lint` | 全部工作区 lint（eslint） |
| `pnpm typecheck` | 全部工作区类型检查（server `tsc --noEmit`、web `vue-tsc --noEmit`） |
| `pnpm build` | 先 web（`vue-tsc --noEmit && vite build`）后 server（`tsc`） |
| `pnpm start` | 生产启动：智能构建——`server/dist` / `web/dist` 产物缺失时才构建（server `tsc` / web `vue-tsc --noEmit && vite build`），存在则直接 `node server/dist/index.js`（默认 `0.0.0.0:3000`，`--host` / `--port` 原样透传给服务进程） |
| `pnpm start:rebuild` | 强制 `pnpm build`（server+web 全量）后再启动（等同旧版 `pnpm start` 行为） |

server 包内脚本（`pnpm --filter @llmproxy/server <script>`）：

| 命令 | 说明 |
| --- | --- |
| `test` | 单测（vitest run，不含集成测试） |
| `test:integration` | 仅跑集成测试 `src/server/integration.test.ts`（supertest 打真实应用） |
| `test:watch` | vitest watch 模式 |
| `exec vitest run --coverage` | 覆盖率（已内置 `@vitest/coverage-v8`） |

### 开发流程 Dev Workflow

推荐按以下顺序提交代码：

```text
改代码 → pnpm typecheck → pnpm lint → pnpm test → test:integration → pnpm build
```

1. 改代码（遵循「约定与规范」）
2. `pnpm typecheck`：先过类型关，避免把类型错误带到后面
3. `pnpm lint`：静态检查
4. `pnpm test`：单元测试（各模块自带 `*.test.ts`）
5. `pnpm --filter @llmproxy/server test:integration`：端到端验证路由装配与协议转换
6. `pnpm build`：确认生产构建通过
7. `pnpm start` 后用 Quickstart 里的两个 curl 手动冒烟验证

### 模块设计说明 Module Design

**config（配置）**
- `schema.ts`：Zod 定义 `UpstreamSchema` / `DownstreamModelSchema` / `ConfigSchema`，是配置的单一事实来源；缺省值（`timeoutMs: 30000`、`disabled: false`）在此补齐
- `loader.ts`：jsonc-parser 读取 JSONC（支持注释与尾逗号）；语法错误抛 `ConfigError('PARSE')`，模式不符抛 `ConfigError('VALIDATE')`（带字段路径）
- `store.ts`：`ConfigStore` 持有内存态配置。`set()` 用 `fast-deep-equal` 与当前值深度比较，**内容一致直接早退**（防止「管理端写盘 → 文件监听 → 再 set」自触发循环）；写盘走「写临时文件（0600）→ 原子 rename」；首次运行写入带注释的 bootstrap 示例
- `watcher.ts`：chokidar 监听配置文件，`awaitWriteFinish` 200ms 防抖（`stabilityThreshold: 200`）规避编辑器分次保存；重载失败保留旧配置，错误经 `setRecentReloadError` 上报（管理端可查），日志只记错误码不落盘文件内容

**router（路由）**
- `index.ts`：`Router.resolve(alias)` 把下游别名解析为有序候选列表，过滤 `disabled` 上游；别名不存在抛 `ModelNotFoundError`
- `load-balancer.ts`：`RoundRobinLoadBalancer` 按下游模型分桶计数，`count % 候选数` 选起点；纯内存、无随机、无加权
- `fallback.ts`：`executeWithFallback` 从轮询起点开始按 wrap 顺序逐个尝试；`isFallbackableAxiosError` 判定可回退性（网络错误 / 超时 / 429 / 5xx 可回退，其它 4xx 中断）

**upstream（上游客户端）**
- `openai.ts`：`OpenAIUpstreamClient` 用 axios 请求上游。非流式 `chatCompletion` 返回 JSON；流式 `chatCompletionStream` 返回 `{ stream, abort, connectError }`。其中 `connectError` 是连接阶段结果的 Promise：axios 流式请求在后台发起，try/catch 抓不到它的失败，调用方必须 `await connectError` 判断连接成败。`abort` 立即拆除底层 TCP 连接。鉴权头只来自配置的 `apiKey`，绝不用调用方传入的 Authorization

**converters（转换器）**
- `openai-to-ollama-request.ts`：OpenAI 请求体 → Ollama `/api/chat` 请求体（采样参数映射、多模态图片收集去重、`response_format` → `format`）
- `openai-to-ollama-response.ts`：OpenAI 非流式响应 → Ollama 响应（`created` unix 秒 → ISO 8601、token 计数映射、tool_calls 告警丢弃）
- `openai-to-ollama-stream.ts`：OpenAI SSE 字节流 → Ollama NDJSON 字节流（Transform 流；逐行解析 `data:` 事件，最后一次 usage 生效，末尾补一行 `done: true`；上游传输错误输出一行 `{ error }` 后结束）
- `openai-to-ollama-models.ts`：OpenAI 模型列表 → Ollama `/api/tags` 结构（模型元数据为固定 stub 值）
- `responses-types.ts`：OpenAI Responses API 类型定义（网关边界子集：请求 / 响应 / usage）
- `responses-request.ts`：Responses 请求体 → Chat Completions 请求体（`input`/`instructions` → messages、`max_output_tokens` → `max_tokens`、采样参数白名单透传）
- `responses-response.ts`：上游 chat 非流式响应 → Responses 响应对象（`object: "response"` + `output` 消息）
- `responses-stream.ts`：上游 chat SSE 流 → Responses SSE 事件流（response.created → … → response.completed，usage 实时捕获）

数据流（Ollama 路径）：客户端 → `/api/chat` → 转换器（转 OpenAI 请求）→ 上游客户端 → 上游响应 → 转换器（转 Ollama 响应 / NDJSON 流）→ 客户端。OpenAI 路径 `/v1/chat/completions` 全程透传，只替换模型名；`/v1/responses` 在网关边界做 Responses ↔ Chat 互转。

**server（装配与路由）**
- `openai.ts`：`/v1/models`（返回下游别名列表）、`/v1/chat/completions`（非流式 / SSE 流式透传 + 回退）与 `/v1/responses`（Responses 格式，网关边界互转 + 回退）
- `ollama.ts`：`/api/tags` 与 `/api/chat`（转换 + 回退；`n > 1` 返回 400）
- `admin.ts`：`/admin/api/*` 全部管理端点（上游 CRUD、连通性测试、模型映射、日志、统计、健康、配置）
- `index.ts`：`createApp` 单端口装配：`express.json(10mb)` + 请求日志中间件 + 三组路由 + 静态 SPA + 非 API 前缀回退到 `index.html`；`startServer` 完成路径定位、配置装载与监听

**logger（日志）**
- log4js 双类别：app（文本 pattern layout）与 api（JSON 行，兼容原 pino 契约），按本地日期分文件（`app-YYYY-MM-DD.log` / `api-YYYY-MM-DD.log`），写日志前检查日期翻转并自动切换目标流
- **SQLite 双写**：装配层 `setLogStore` 注入 `LogStore` 后，`getLogger()` 返回 Proxy 包装，日志方法先写 SQLite（try-catch 隔离，失败只降级不抛错）再写文件；未注入时行为与原来完全一致
- 敏感头脱敏：`authorization` / `x-api-key` 在记录请求头时过滤；写库前 `sanitizeRawValue` 按任意嵌套层级剔除，`raw` 列永不含敏感头
- `sweep.ts`：超过 5 天的 `app-*.log` / `api-*.log` 在启动时与每 6 小时自动清理（按 mtime 判定）

**logstore（日志 SQLite 存储）**
- `LogStore` 只做存储（insert / query / cleanup / close），不写文件、不碰 HTTP：`logs` 表 + `(type, time DESC)` 复合索引，WAL + 预编译语句支撑高频写入
- `query`：type 必填 + time 范围 + 级别下限 + keyword 模糊匹配（msg / url / request_id / category 任一命中），`ORDER BY time DESC, id DESC`，返回满足过滤条件的 `total`（不含分页）
- `cleanup(maxAgeMs)`：`DELETE FROM logs WHERE time < now - maxAgeMs`；保留期与文件 sweep 一致（5 天），启动一次 + 每 6 小时（调度装配见 `server/src/server/index.ts`）

**stats（统计）**
- `StatsCounter` 纯内存计数：按上游聚合 requests / errors / totalLatencyMs，`since` 为构造时刻（进程启动），重启清零；`snapshot()` 时计算平均延迟

### 约定与规范 Conventions

- **中文注释**：代码注释用中文，命名与技术术语保留英文
- **2 空格缩进**：全仓库统一
- **ESM NodeNext**：`type: "module"`，跨文件导入必须带 `.js` 后缀（如 `import { getLogger } from '../logger/index.js'`）
- **TypeScript strict**：`strict: true`，禁止宽松类型
- **无 `as any`**：唯一豁免是转换器函数签名（`convertChatRequest` / `convertChatResponse` 的入参为动态请求体，带 `eslint-disable-next-line @typescript-eslint/no-explicit-any` 注释说明）
- **敏感信息不外泄**：apiKey 不落日志、不回显、不转发客户端密钥；管理端接口一律掩码返回

### 添加新功能指南 Adding Features

**新增一个下游协议端点**：在 `server/src/server/` 新建路由模块（或扩展现有模块），复用 `Router.resolve` + `executeWithFallback` + 上游客户端；需要换协议形状时写对应的 converter；最后在 `createApp`（`server/index.ts`）注册。参照 `ollama.ts` 的结构即可

**新增一个上游客户端实现**：在 `server/src/upstream/` 下实现新客户端类（至少提供 `listModels` 与 `chatCompletion` / `chatCompletionStream`），再在 `server/index.ts` 的 `rebuildClients` 工厂里按上游类型构建；`openai.ts` / `ollama.ts` 通过注入的 `getUpstreamClient` 无感切换

**新增一个管理页面**：在 `web/src/views/` 新建 `.vue` 页面，在 `web/src/router.ts` 的路由表 children 中注册（挂在 `AdminLayout` 布局下），并同步 `web/src/layouts/AdminLayout.vue` 的菜单项与图标；数据通过 `web/src/api/client.ts`（baseURL 已是 `/admin/api`）调用对应端点

## License

MIT

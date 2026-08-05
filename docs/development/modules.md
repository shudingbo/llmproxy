# 模块地图（modules.md）

> 本文基于 `server/src` 与 `web/src` 的当前实际代码编写，与真实文件一一对应。
> 项目为 pnpm workspace：`server`（后端，包名 `@llmproxy/server`）与 `web`（前端，包名 `@llmproxy/web`）。

## 1. 目录结构总览

### 1.1 server（后端，`server/src/`）

```
server/src/
├── index.ts                  # 服务入口：调用 startServer() 启动进程
├── paths.ts                  # 路径工具：数据目录 / 配置文件 / 日志文件定位
│
├── config/                   # 配置模块（Zod 定义 + 加载 + 内存态 + 文件监听）
│   ├── index.ts              #   统一出口（重导出全部公共 API）
│   ├── schema.ts             #   配置的 Zod 模式与推断类型
│   ├── loader.ts             #   JSONC 加载器（解析 + 校验）
│   ├── store.ts              #   ConfigStore：内存态 / 原子持久化 / 变更订阅
│   └── watcher.ts            #   chokidar 文件监听，变更自动重载
│
├── router/                   # 路由模块（别名映射 + 负载均衡 + 顺序回退）
│   ├── index.ts              #   Router.resolve：下游别名 → 有序候选
│   ├── load-balancer.ts      #   RoundRobin / SessionAffinity 均衡器
│   ├── fallback.ts           #   executeWithFallback 顺序回退执行器
│   └── errors.ts             #   ModelNotFoundError 等路由错误
│
├── session/                  # 会话亲和路由（今日新增）
│   ├── key.ts                #   extractSessionKey：从请求提取会话键
│   └── db.ts                 #   SessionStore：会话粘附的 SQLite 存储
│
├── logstore/                 # 日志 SQLite 存储（今日新增）
│   └── index.ts              #   LogStore：日志条目持久化 / 查询 / 清理
│
├── logger/                   # 日志模块（今日改造：log4js + SQLite 双写）
│   ├── index.ts              #   双类别日志 + requestLogger 中间件 + setLogStore 双写
│   └── sweep.ts              #   日志文件保留期清理（app-*.log / api-*.log）
│
├── stats/                    # 统计模块
│   └── counter.ts            #   StatsCounter：按上游聚合请求 / 错误 / 耗时
│
├── upstream/                 # 上游客户端模块
│   └── openai.ts             #   OpenAIUpstreamClient：模型列表 / 聊天 / SSE 流式
│
├── converters/               # 协议转换模块（OpenAI ↔ Ollama + Responses ↔ Chat）
│   ├── types.ts              #   共享类型（Ollama 模型列表结构）
│   ├── openai-to-ollama-models.ts    # 模型列表转换
│   ├── openai-to-ollama-request.ts   # 聊天请求转换
│   ├── openai-to-ollama-response.ts  # 非流式响应转换
│   ├── openai-to-ollama-stream.ts    # SSE → NDJSON 流式转换
│   ├── responses-types.ts    #   Responses 请求 / 响应 / usage 类型（边界子集）
│   ├── responses-request.ts  #   Responses 请求 → Chat 请求
│   ├── responses-response.ts #   Chat 非流式响应 → Responses 响应对象
│   └── responses-stream.ts   #   Chat SSE 流 → Responses SSE 事件流
│
└── server/                   # 装配层与下游适配
    ├── index.ts              #   createApp 装配 + startServer 进程引导
    ├── openai.ts             #   /v1 OpenAI 兼容下游路由（models / chat / responses）
    ├── ollama.ts             #   /api Ollama 兼容下游路由
    ├── admin.ts              #   /admin/api 管理端路由
    ├── admin-helpers.ts      #   maskApiKey / scrubSensitiveKeys 脱敏工具
    ├── downstreams.ts        #   下游端点清单（单一真相源）
    └── listen.ts             #   resolveListen：监听 host / port 解析（cli > config > 缺省）
```

每个目录的职责一句话：

- `config/`：配置的定义、加载、内存态、持久化与热重载，全项目的配置事实来源。
- `router/`：把下游模型别名解析为上游候选，并完成负载均衡与失败回退的决策（不含 HTTP）。
- `session/`：会话亲和路由的键提取与 SQLite 持久化。
- `logstore/`：日志条目的 SQLite 存储层，供管理端查询与双写。
- `logger/`：基于 log4js 的双类别日志（app 文本 / api JSON），负责输出、双写与文件清理。
- `stats/`：进程内请求统计计数器。
- `upstream/`：OpenAI 兼容上游的 HTTP 客户端。
- `converters/`：OpenAI 与 Ollama 协议之间、Responses 与 Chat Completions 之间的纯数据转换（不发起网络请求）。
- `server/`：Express 应用装配、三组下游路由的 HTTP 适配与进程引导。

### 1.2 web（前端，`web/src/`）

```
web/src/
├── main.ts                  # 应用入口：创建 app，注册 Pinia / Router / Element Plus
├── App.vue                  # 根组件：仅渲染 <router-view>
├── router.ts                # vue-router 路由表（AdminLayout + 6 个子页面）
├── env.d.ts                 # 类型声明
│
├── api/
│   └── client.ts            # axios 实例（baseURL: /admin/api）
│
├── layouts/
│   └── AdminLayout.vue      # 管理端布局：左侧导航菜单 + 右侧主内容区
│
└── views/
    ├── Dashboard.vue        # 仪表盘：指标卡片 + 下游 API 端点列表
    ├── Upstreams.vue        # 上游管理：增删改查 + 连通性测试
    ├── Models.vue           # 下游模型别名管理
    ├── Logs.vue             # 日志查询（app / api 双类型）
    ├── Sessions.vue         # 会话粘附列表与操作
    └── Stats.vue            # 请求统计展示
```

web 端职责一句话：纯管理界面，所有数据经 `/admin/api` 获取，不直连上游；开发环境由 Vite 代理（端口 5175）转发 `/admin/api` 到后端 `http://127.0.0.1:3000`。

## 2. 模块详表

### 2.1 `config/` 配置模块

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `schema.ts` | 用 Zod 定义配置结构：`upstreams`（至少 1 个上游）、`downstreamModels`（别名 → 候选列表映射）、`server`（监听配置，可选）、`routing`（会话亲和配置，可选）。缺省值由 schema 补齐（如 `timeoutMs: 30000`、`disabled: false`、`cleanupMaxAgeMs: 604800000`） | `ConfigSchema`、`UpstreamSchema`、`UpstreamCandidateSchema`、`DownstreamModelSchema`、`RoutingSchema`；类型 `Config`、`Upstream`、`UpstreamCandidate`、`ServerListen`、`Routing` |
| `loader.ts` | 读取 JSONC 文件（支持注释与尾逗号，用 `jsonc-parser`）并按 `ConfigSchema` 校验 | `loadConfigFromFile(path)`、`ConfigError`（`code: 'PARSE' \| 'VALIDATE'`） |
| `store.ts` | `ConfigStore`：持有唯一内存态配置；`set()` 先深比较去重（防 watcher 自环）、重新校验、原子写盘（`${path}.tmp` 临时文件 + rename，权限 0600）、再通知订阅者；文件缺失时写入 bootstrap 示例 | `ConfigStore`（`get` / `subscribe` / `set` / `getRecentReloadError` / `setRecentReloadError`）、类型 `WatchSource`（`'admin' \| 'watch' \| 'bootstrap'`） |
| `watcher.ts` | chokidar 监听配置文件变更，`awaitWriteFinish` 200ms 防抖；变更后重新加载校验，合法则 `store.set(..., { source: 'watch' })`，非法则保留旧配置并上报 `reloadError`（日志脱敏，不落文件内容） | `startConfigWatcher(path, store)` |
| `index.ts` | 模块统一出口，重导出以上全部公共 API | 聚合导出 |

依赖关系：`loader.ts` 依赖 `schema.ts`；`store.ts` 依赖 `loader.ts` 与 `schema.ts`；`watcher.ts` 依赖 `loader.ts`、`store.ts`、`logger`；`index.ts` 聚合导出。`watcher.ts` 与 `store.ts` 相互解耦：watcher 只上报重载错误，store 不感知监听。

### 2.2 `router/` 路由模块

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `index.ts` | `Router.resolve(downstreamModel)`：把下游别名映射为有序候选列表。别名不存在抛 `ModelNotFoundError`；过滤 `disabled` 上游（保留顺序）；全部禁用时记警告并返回原列表 | `Router` 类 |
| `load-balancer.ts` | 两种均衡策略 + 接口定义：`RoundRobinLoadBalancer`（按下游模型分桶计数、取模轮询）；`SessionAffinityLoadBalancer`（有 sessionKey 时命中记录且上游仍在候选 → touch 保持粘附；否则用兜底均衡器重选并 bind）。`RequestCtx` 携带 `downstreamModel` / `sessionKey` / `client` | `RequestCtx`、`LoadBalancer` 接口、`RoundRobinLoadBalancer`、`SessionAffinityLoadBalancer`、`EmptyCandidatesError`、`SessionStoreLike` 接口 |
| `fallback.ts` | `executeWithFallback`：从均衡器选出的起点按 wrap 顺序逐个尝试；成功立即返回（带 attemptLog 与 onSuccess 回调，供调用方 rebind 会话）；失败且 `fallbackable` 继续、不可回退立即中断；全部失败返回最后一个错误。附 `isFallbackableAxiosError`（网络错误 / 超时 / 429 / 5xx 可回退，其余 4xx 不可） | `executeWithFallback<T>`、`isFallbackableAxiosError`、类型 `CallResult<T>`、`FallbackResult<T>`、`AttemptLogEntry` |
| `errors.ts` | 路由相关错误类型 | `ModelNotFoundError` |

依赖关系：`index.ts` 依赖 `config/schema`、`logger`、`errors`；`load-balancer.ts` 依赖 `config/schema`、`session/db`（类型）；`fallback.ts` 依赖 `config/schema`、`load-balancer`。router 不发起任何 HTTP，回退策略的 `callFn` 由调用方（`server/openai.ts` / `server/ollama.ts`）注入。

### 2.3 `session/` 会话亲和模块（今日新增）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `key.ts` | `extractSessionKey(req, body)`：优先级 1 取 `X-OpenWebUI-Chat-Id` header（client=`open-webui`）；优先级 2 取 `X-Session-Id` header（值以 `ywnrs` 开头 → client=`ywnrs`，否则 client=`x-session-id`）；优先级 3 对 messages 前 2 条内容前缀做 sha256（client=`content-hash`）；都不满足返回 `undefined`。只做提取，消费方自行拼接 `${downstreamModel}::${raw}` | `extractSessionKey`、`SessionKeyResult` |
| `db.ts` | `SessionStore`：会话粘附的 SQLite 存储（`llmproxy.db` 的 `sessions` 表）。WAL 模式；预编译语句（better-sqlite3 同步 API）。提供 `get` / `bind`（UPSERT 覆盖）/ `touch` / `rebind` / `list`（分页 + client 精确匹配 + keyword 模糊）/ `delete` / `clear` / `cleanup`（按 `updated_at` 过期删除）/ `close` | `SessionStore`、`SessionRow`、`SessionBindInfo`、`SessionListResult` |

依赖关系：`db.ts` 依赖 `better-sqlite3`；`load-balancer.ts` 通过 `SessionStoreLike` 接口消费它（解耦路由决策与存储）。DB 文件路径由装配层传入（`join(getDataDir(), 'llmproxy.db')`）。

### 2.4 `logstore/` 日志存储模块（今日新增）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `index.ts` | `LogStore`：日志条目的 SQLite 存储（与 `sessions` 表共存于同一 `llmproxy.db`，WAL 多连接安全）。`insert` 高频写入走预编译语句；`query` 分页查询（`type` 必填 + time 范围 + minLevel + keyword 模糊，最新在前）；`cleanup(maxAgeMs)` 与 `deleteBefore(before)` 复用同一预编译语句。camelCase 入参 → snake_case 列名 | `LogStore`、`LogEntry`、`LogRow`、`LogQueryOptions`、`LogQueryResult` |

依赖关系：仅 `better-sqlite3`。存储路径由装配层传入；不负责格式化、不写文件、不碰 HTTP。

### 2.5 `logger/` 日志模块（今日改造）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `index.ts` | log4js 双类别日志：`app`（文本 pattern layout，含时间戳/级别/类别）与 `api`（自定义 `pinoJson` JSON layout，保持与原 pino 契约兼容）。配置外置 `~/llmproxy/log4js.json`（缺省自动写入一份，`buildDefaultLog4jsConfig` 生成）。按日轮转（`dateFile`，`fileNameSep: '-'`，产出 `app-YYYY-MM-DD.log` / `api-YYYY-MM-DD.log`）+ stdout 镜像。`setLogStore` 注入 `LogStore` 后 `getLogger` 返回 Proxy 双写包装：先写 SQLite（try-catch 隔离，失败仅记一次告警），再写文件。`requestLogger` 中间件：每个请求生成 `requestId`，响应 `finish` 时输出结构化日志，绝不记录 Authorization / x-api-key（`redactHeaders`）。`sanitizeRawValue` 递归剔除敏感键。重导出 sweep 清理入口 | `configureLogging`、`getLogger`、`getApiLogger`、`setLogStore`、`requestLogger`、`buildDefaultLog4jsConfig`、`flushLoggerSync`；重导出 `initLogRetention` / `stopLogRetention` / `sweepOldLogs` |
| `sweep.ts` | 日志文件保留期清理：`sweepOldLogs(dir)` 删除 mtime 早于 `now - RETENTION_DAYS(5) 天` 的 `app-*.log` / `api-*.log`；`sweepLogsBefore(dir, beforeMs)` 手动清理；`initLogRetention` 启动立即执行一次 + 每 6 小时定时（`unref` 不阻塞退出）。模块保持纯净不依赖 `logger/index`，避免循环依赖 | `sweepOldLogs`、`sweepLogsBefore`、`initLogRetention`、`stopLogRetention`、`RETENTION_DAYS` |

依赖关系：`index.ts` 依赖 `log4js`、`nanoid`、`paths`、`logstore`（类型）、`sweep`；`sweep.ts` 不依赖 `index.ts`。双写是可选装配：未调用 `setLogStore` 时行为与纯文件日志完全一致。

### 2.6 `stats/` 统计模块

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `counter.ts` | `StatsCounter`：纯内存计数，按上游 id 聚合 `requests` / `errors` / `totalLatencyMs`。`recordAttempt` 每次尝试计一次（成功失败都计，失败额外计错误）；`snapshot` 生成快照（平均耗时 = 总耗时 / 请求数）；`setSince` 覆盖统计窗口起点。不落盘、不持久化 | `StatsCounter`、`UpstreamStats`、`StatsSnapshot`、`AttemptInfo` |

依赖关系：无（纯 TS）。

### 2.7 `upstream/` 上游客户端模块

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `openai.ts` | `OpenAIUpstreamClient`：OpenAI 兼容上游的 HTTP 客户端（axios）。`listModels`（GET /models）、`chatCompletion`（非流式 POST /chat/completions，`stream` 为 true 时直接报错）、`chatCompletionStream`（SSE 流式：返回包装 `Readable` + `abort()` + `connectError: Promise<Error | null>` 用于判断连接阶段成败）。apiKey 仅存私有字段，鉴权头只来自配置。不做重试与故障转移（那是 router 的职责） | `OpenAIUpstreamClient`、`openaiClient(upstream)` 工厂、类型 `UpstreamChatRequest` / `UpstreamChatResponse` / `UpstreamStreamResult` |

依赖关系：`axios`、`node:stream`、`config/schema`（类型）。

### 2.8 `converters/` 协议转换模块

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `types.ts` | 共享类型：`OllamaModel` / `OllamaTagsResponse`（对齐 Ollama /api/tags 契约） | `OllamaModel`、`OllamaTagsResponse` |
| `openai-to-ollama-models.ts` | OpenAI 模型列表 → Ollama /api/tags 响应；name/model 复用 OpenAI id，元数据为占位 stub（不发上游请求） | `convertModelsList` |
| `openai-to-ollama-request.ts` | OpenAI 聊天请求 → Ollama /api/chat 请求体：消息只留 role/content；多模态图片收集到顶层 `images`（去重、剥离 data: 前缀）；`temperature`/`top_p`/`stop`/`seed`/`max_tokens` → `options`（max_tokens → num_predict）；`response_format` → `format`；tools 不支持，记 info 后丢弃。绝不修改入参 | `convertChatRequest` |
| `openai-to-ollama-response.ts` | OpenAI 非流式响应 → Ollama 非流式响应：只取 choices[0]（调用方已拒绝 n>1）；`created` 秒 → ISO 时间戳；`finish_reason` 仅 'stop'/'length' 可映射；usage 映射为 `prompt_eval_count` / `eval_count`；choices 为空抛错 | `convertChatResponse`、`mapFinishReason`、`OllamaChatResponse` |
| `openai-to-ollama-stream.ts` | SSE → NDJSON 流式转换：`Transform` 逐行解析 OpenAI SSE（`data: <json>` / `data: [DONE]`），输出 Ollama NDJSON（每行一个对象）；usage 实时捕获（最后一次生效）；内容块解析失败 warn + 跳过；上游传输错误输出一行 `{ error }` 后结束；`done: true` 保证只输出一次 | `createOpenAIToOllamaStream` |
| `responses-types.ts` | OpenAI Responses API 类型定义（网关边界使用的子集）：请求 `ResponsesRequest` / 输入项 `ResponsesInputItem`、响应 `ResponsesResponse` / `ResponsesOutputMessage` / `ResponsesOutputTextPart`、`ResponsesUsage`；只声明本仓库转换器用到的字段，其余按宽松结构处理 | `ResponsesRequest`、`ResponsesResponse`、`ResponsesOutputMessage`、`ResponsesOutputTextPart`、`ResponsesUsage` |
| `responses-request.ts` | Responses 请求体 → Chat 请求体：`instructions`（非空）前置 system 消息；`input` 为字符串 → user 消息、为数组逐项映射（仅带 role 的项，其余忽略）；`max_output_tokens` → `max_tokens`；采样参数白名单（temperature / top_p / stop / seed / presence_penalty / frequency_penalty / response_format）原样透传。绝不修改入参 | `responsesToChatMessages`、`responsesRequestToChat` |
| `responses-response.ts` | 上游 chat 非流式响应 → Responses 响应对象：`object: 'response'` + `output` 消息数组（`output_text` 片段，annotations 固定空数组）；usage 字段改名（prompt_tokens → input_tokens / completion_tokens → output_tokens，缺省 0，上游无 usage 时整个字段省略）；`model` 用下游别名 | `chatResponseToResponses` |
| `responses-stream.ts` | Chat SSE → Responses SSE 事件流：`Transform` 逐行解析上游 chat SSE；首个 delta 前输出 opening 序列（response.created → in_progress → output_item.added → content_part.added），delta 期间输出 output_text.delta，结束（[DONE] / EOF）输出收尾序列（output_text.done → content_part.done → output_item.done → response.completed，usage 注入 completed）；空输出也保持完整序列；上游传输错误输出 error 事件后结束，不做重试 | `createResponsesStream` |

依赖关系：`request` / `response` / `stream`（Ollama 方向）依赖 `logger`；`models` 依赖 `types`；`responses-request` 依赖 `responses-types` 与 `upstream/openai`（类型）；`responses-response` / `responses-stream` 依赖 `responses-types` 与 `nanoid`（`responses-stream` 另依赖 `logger`）。全部为纯数据转换，不发起网络请求。

### 2.9 `server/` 装配层与下游适配

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `index.ts` | 装配层与进程引导：`createApp(deps)` 组合 Express 应用（见 §3 装配链路）；`startServer()` 进程入口（配置 log4js、定位 web/dist、装载 ConfigStore、组合应用、启动日志保留清理、`parseCliArgs` 解析命令行 `--host` / `--port` 后交 `resolveListen` 监听端口、打印下游端点清单） | `createApp`、`startServer`、`AppDeps` |
| `openai.ts` | OpenAI 兼容下游：`GET /v1/models`（返回下游别名列表）、`POST /v1/chat/completions`（非流式/流式透传 + 顺序回退 + 尝试计数 + 会话改绑）、`POST /v1/responses`（Responses API：边界经 `converters/responses-*.ts` 与 Chat Completions 互转，非流式返回 `object=response` 对象 / `stream: true` 返回 Responses SSE 事件流，复用同一套回退 + 会话改绑逻辑）。chat 请求体原样透传不校验；用 `res 'close'` 自建 AbortSignal 中止上游；全部候选失败返回 502，未知模型 404 | `registerOpenAIRoutes`、`OpenAIDeps` |
| `ollama.ts` | Ollama 兼容下游：`GET /api/version`、`GET /api/tags`、`POST /api/chat`（Ollama 形状 → OpenAI 上游 → 转回 Ollama 形状，含 NDJSON 流式；`n > 1` 先于一切拒绝 400）。`/api/show`、`/api/generate` 等明确不实现 | `registerOllamaRoutes`、`OllamaDeps` |
| `admin.ts` | 管理端 `/admin/api/*`：上游增删改查与连通性测试、下游模型映射整体替换、日志查询与手动清理、统计、会话粘附列表/删除/清空/清理、健康检查、配置查看与重载错误。apiKey 一律掩码，响应不落敏感信息 | `registerAdminRoutes`、`AdminDeps` |
| `admin-helpers.ts` | 脱敏工具：`maskApiKey`（保留后 4 位）、`scrubSensitiveKeys`（递归清洗 authorization / api_key / x-api-key） | `maskApiKey`、`scrubSensitiveKeys` |
| `downstreams.ts` | 下游端点清单 `DOWNSTREAM_ENDPOINTS`：启动日志与 `/admin/api/health` 共用的单一真相源；增删下游路由只需改本文件 | `DOWNSTREAM_ENDPOINTS`、`DownstreamEndpoint` |
| `listen.ts` | `resolveListen(config, { cli })`：按 `命令行 --host/--port > config.server > 缺省（0.0.0.0:3000）` 的优先级解析监听地址；host/port 相互独立可选，未指定的一侧回落下一优先级；**不再读取环境变量 HOST/PORT**；`source` 字段标记来源（`'cli' | 'config' | 'default'`，仅日志用）；cli 的 port 非法值（非 1-65535 整数）与 host 空值忽略并回落下一优先级，不抛错 | `resolveListen`、`ResolvedListen`、`DEFAULT_HOST`、`DEFAULT_PORT` |

依赖关系：`index.ts` 依赖 config / router / session / logstore / logger / stats / upstream / paths 与 server 子模块，是整个后端的装配中枢；`openai.ts`、`ollama.ts` 依赖 converters / router / session/key / upstream / config；`admin.ts` 依赖 config / logger / logstore / stats / session / upstream / server 子模块。

### 2.10 `paths.ts` 路径工具

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `paths.ts` | 统一管理路径：数据目录 `<homedir>/llmproxy`（自动创建，0700）、配置文件 `llmproxy.jsonc`、日志目录 `logs`、按日日志文件 `app-YYYY-MM-DD.log` / `api-YYYY-MM-DD.log`、log4js 配置 `log4js.json`。仅负责路径推导与目录引导 | `getDataDir`、`getConfigPath`、`getLogDir`、`getAppLogFilePath`、`getApiLogFilePath`、`getLog4jsConfigPath`、`getLocalDateString`（`getLogFilePath` 为已废弃别名） |

依赖关系：`node:fs`、`node:os`、`node:path`。

### 2.11 web 端模块

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 应用入口：创建 Vue app，注册全部 Element Plus 图标为全局组件，安装 Pinia / Router / Element Plus，`mount('#app')`；含 Edge 浏览器最小化时拦截 `history.replaceState` 的兼容处理 |
| `App.vue` | 根组件：仅渲染 `<router-view />` |
| `router.ts` | vue-router 路由表：`/` 挂 `AdminLayout`，`/dashboard`、`/upstreams`、`/models`、`/logs`、`/sessions`、`/stats` 六个子路由均为懒加载，`meta` 携带标题与图标名 |
| `api/client.ts` | axios 实例：`baseURL: '/admin/api'`（开发环境由 Vite 代理转发） |
| `layouts/AdminLayout.vue` | 管理端布局：左侧 `el-menu`（router 模式，6 个菜单项与路由表一一对应）+ 右侧 `el-main` 渲染子路由 |
| `views/Dashboard.vue` | 仪表盘：4 张指标卡片（活跃上游 / 模型总数 / 请求数 / 错误率）+ 下游 API 端点列表，30s 自动刷新 |
| `views/Upstreams.vue` | 上游管理：列表（暂停灰底）、新增 / 编辑 / 删除、连通性测试 |
| `views/Models.vue` | 下游模型别名管理：别名列表 + 新增别名 + 候选上游排序（vuedraggable） |
| `views/Logs.vue` | 日志查询：app / api 双类型，按日期 / 级别 / 关键词筛选，分页 |
| `views/Sessions.vue` | 会话粘附列表：client 下拉 + 关键字筛选，删除 / 清空 / 手动清理操作 |
| `views/Stats.vue` | 请求统计：since 窗口说明 + 全量汇总 + 按上游明细，手动刷新 |

## 3. 关键装配链路：`server/index.ts` 的 `createApp`

`createApp(deps)` 是后端的装配中枢，依赖注入与单例全部在此建立：

1. **上游客户端映射（配置驱动重建）**：按 `store.get().upstreams` 构建 `Map<upstreamId, OpenAIUpstreamClient>`；`store.subscribe(rebuildClients)`，配置变更时整体重建，新增 / 删除上游无需重启即时生效。
2. **单例创建**：
   - `SessionStore`（`<dataDir>/llmproxy.db`）与 `LogStore`（同一 DB 文件，WAL 多连接安全）
   - `setLogStore(logStore)`：启用日志 SQLite 双写（可选装配，不注入时纯文件）
   - 负载均衡器：`routing.sessionAffinity.enabled !== false` 时用 `SessionAffinityLoadBalancer(sessionStore, new RoundRobinLoadBalancer())`，否则纯 `RoundRobinLoadBalancer`（开关启动时确定，不做热更新重选）
   - `StatsCounter`
   - `Router(store.get())` 兼容实例（实际处理按请求用 `store.get()` rebuild-per-call，保证无过期引用）
3. **后台清理调度**（均 `unref` 不阻塞退出）：
   - 会话粘附：启动执行一次 + 每 `cleanupIntervalMs`（缺省 1h，0 关闭），按 `cleanupMaxAgeMs`（缺省 1 周，0 永不过期）清理
   - 日志 DB：启动执行一次 + 每 6 小时，按 `RETENTION_DAYS`（5 天）清理
4. **Express 中间件顺序**：
   ```
   express.json({ limit: '10mb' })     // 请求体解析，先于一切路由
     → requestLogger                    // requestId + api 类别请求日志
     → registerAdminRoutes(app, ...)    // /admin/api/*
     → registerOpenAIRoutes(app, ...)   // /v1/*
     → registerOllamaRoutes(app, ...)   // /api/*
     → express.static(webDistPath)      // 静态 SPA 产物
     → SPA 回退                          // 非 /v1 /api /admin 前缀 → index.html；
                                        //   产物缺失时返回 503 JSON（admin_ui_not_built）
   ```

`startServer()` 进程引导：`configureLogging()`（幂等，先于任何 logger 调用）→ 定位 `webDistPath`（三个候选路径）→ `new ConfigStore(getConfigPath())`（历史重载错误仅告警不阻塞）→ `createApp` → `initLogRetention(getLogDir())`（日志文件 sweep）→ `resolveListen` 解析监听 → `app.listen` → 打印下游端点清单。

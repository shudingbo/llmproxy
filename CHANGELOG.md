# Changelog

本项目所有值得记录的变更都会汇总到本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **POST /rerank 与 /v1/rerank 重排序透传代理**：OpenAI 兼容下游新增文本重排序端点（`/v1/rerank` 为 `/rerank` 的同义路径，两路径共享同一 handler）。按 `/v1/embeddings` 模式实现：别名解析 → 轮询起点 → 顺序回退；仅改写 model 为上游侧模型名，其余字段原样透传；不走会话亲和（不写 sessions 表）；上游 404 视为不支持 → 可回退，其余 4xx 立即中断；全部失败返回 502 no_upstream。JSON body 上限由 server.bodyLimit 配置，见下条
- **下行端点清单**：DOWNSTREAM_ENDPOINTS 与 /admin/api/health 新增 POST /rerank 与 POST /v1/rerank 条目
- **server.bodyLimit 可配置 JSON body 上限**：server{} 节新增 bodyLimit（缺省 '10mb'，支持 '10mb' 字符串或数字字节数），全局生效（所有接口共用）；进程级配置，修改后需重启；非法 limit 值（如 'abc'）会导致启动失败；ServerListenSchema 更名为 ServerConfigSchema

## [0.6.0] / 2026-08-07

### 新增

- **`POST /v1/embeddings` 文本嵌入透传代理**：OpenAI 兼容下游新增文本嵌入端点。按 `/v1/chat/completions` 非流式模式实现：别名解析 → 轮询起点 → 顺序回退；仅改写 `model` 为上游侧模型名，其余字段原样透传。embeddings 无多轮会话语义，不走会话亲和（不写 sessions 表）。上游 404 视为该上游不支持 embeddings → 可回退（切下一候选），其余 4xx（401/403/400）立即中断；全部失败返回 `502 {"error": "no_upstream"}`
- **下行端点清单**：`DOWNSTREAM_ENDPOINTS` 与 `/admin/api/health` 新增 `POST /v1/embeddings` 条目（文本嵌入）

## [0.5.0] / 2026-08-05

### 变更

- **`responsesApi` 取值改为 `'native' | 'convert'`（缺省 `'convert'`）**：`'native'` 原生透传——下游 `/v1/responses` 请求体（除 `model` 改写为上游侧模型名、`stream` 按分支强制外）原样打到 `POST {baseUrl}/responses`，非流式响应 JSON 与流式 SSE 事件原样回转，不再经 `converters/responses-*.ts` 与 Chat Completions 互转；`'convert'`（缺省）保持原有转换路径（行为与更改前一致）：网关边界把 `/v1/responses` 转为 `/v1/chat/completions` 请求上游
- **管理端「检测」按钮**：新增 / 编辑上游弹窗的 Responses API 下拉旁可一键检测，自动判定该上游应选 `native` 还是 `convert`。两步检测：① 非流式 `POST {baseUrl}/responses`（`{model, input: 'ping', max_output_tokens: 1}`）返回 200 且 `object === 'response'`；② 流式同请求并消费 SSE 事件流验证事件完整（`response.completed` 收到，且 message item 有 `output_item.added`、`content_part.added` 前置）。两步都过 → `native`；任一失败 → `convert`
- **404 防护**：原生透传分支中上游返回 404 视为「该上游实际不支持」→ 可回退（切下一候选），全部候选 404 耗尽返回 `502 {"error": "no_upstream"}`。语义变化：真实坏 model 的 404 从「立即 404」变为「回退 → 可能 502」
- 响应 `model` 字段语义（已知取舍）：原生透传路径响应 `model` 为上游侧模型名（与 `/v1/chat/completions` 透传一致，不回写别名）；转换路径仍为下游别名。同一别名两条路径的响应 `model` 不一致属已知设计取舍

### 移除

- 运行时 Responses 支持探测（`responses-probe.ts` / `ResponsesSupportRegistry`）与 `responsesApi: 'auto'` 取值

## [0.4.1] / 2026-08-05

- 会话亲和新增 `X-Session-Id` header 提取：部分客户端把会话 id 放在该通用 header；值以 `ywnrs` 开头时 Client 记为 `ywnrs`，否则记为 `x-session-id`。优先级在 `X-OpenWebUI-Chat-Id` 之后、内容前缀哈希之前；管理端 Sessions 页客户端筛选新增对应选项

## [0.4.0] / 2026-08-04

### ⚠ BREAKING CHANGES

- **配置字段位置变更**：`max_context_length` 从 `Upstream` 移到 `UpstreamCandidate`（候选层）。同一上游跑不同模型时，各自的上下文大小需要各自配置。**0.3.x 配置中的上游 `max_context_length` 字段会被 zod 静默丢弃**——升级前需手动把字段挪到对应候选行。
- **探测接口变更**：`POST /admin/api/upstreams/probe-context` 改为 `POST /admin/api/candidates/probe-context`。请求体从 `{ id | baseUrl, apiKey? }` 改为 `{ upstreamId, model, baseUrl?, apiKey? }`（探测粒度对齐到候选 `(upstreamId, model)` 二元组）。
- **Node 最低版本**：`>=18` 收紧到 `>=22`（与 `better-sqlite3@13.x` 的 `engines: ">=22"` 对齐）。

### 新增
- 仓库根 `.npmrc` 新增 `ignore-scripts=true`：better-sqlite3 v13.0.2 自带 prebuilds（`package/prebuilds/*.node`），`require()` 时直接按 `process.platform-arch` 加载，**不依赖 install script 触发 node-gyp**。规避 npm publish 时隐式注入 `"install": "node-gyp rebuild"` 后触发 `find VS` 失败的 bug（[WiseLibs/better-sqlite3#1503](https://github.com/WiseLibs/better-sqlite3/issues/1503)）。
- 根 `package.json` 新增 `pnpm.onlyBuiltDependencies: []`：双保险，确保 pnpm 也不跑任何 build script。

### 移除

- 管理端「新增/编辑上游」对话框移除「最大上下文」字段与「自动」按钮（字段已迁到候选层）
- 管理端「Models」页每个候选行新增「最大上下文」输入框 + 「自动」按钮（调 `/candidates/probe-context`）

## [0.3.0] - 2026-08-04

### 新增

- 上游 `max_context_length` 配置（模型最大上下文，可手动设置或自动探测；`null` 显式清空，缺省不设）；管理界面新增「最大上下文」字段与「自动」按钮，点「自动」调用探测接口自动填写
- 新增探测接口 `POST /admin/api/upstreams/probe-context`：body 可传 `id`（编辑模式，用配置真实密钥）或 `baseUrl` / `apiKey`（新增模式覆盖）；自动探测支持 llama.cpp（`/v1/models` 的 `data[].meta.n_ctx`）与 LM Studio（`/api/v1/models` 的 `models[].loaded_instances[].config.context_length`），并行取首个成功
- 下游模型列表聚合 `meta.n_ctx`：`GET /v1/models` 与 `GET /api/tags` 返回的每个模型带 `meta: { n_ctx }`，值为该别名分组内候选上游 `max_context_length` 的最小值；所有候选均未配置时该模型不带 meta

### 修复

- 修复 LM Studio 探测在未指定模型时必失败的问题（相对参考实现，未指定模型时从已加载实例中取上下文长度）

## [0.2.0] - 2026-08-03

### 新增

- 会话亲和路由：内容前缀哈希 / Open WebUI `X-OpenWebUI-Chat-Id` 会话键 → SQLite 粘附映射，同一会话请求粘附同一上游（最大化 LLM prompt cache 利用率）；管理端会话页（列表 / 解绑 / 清空 / 手动清理）；自动清理（默认保留 1 周，可配置）
- 日志存储 SQLite 化：日志双写（文件 + SQLite `logs` 表），管理端日志查询切 SQLite（type / 日期 / 级别 / 关键词过滤 + 倒序分页）
- 日志页页码分页（总条数 / 每页 50 / 100 / 200 / 跳页）
- 日志手动清理：界面选择日期（默认清理 7 天前）删除所选日期之前的 SQLite 记录与日志文件
- 下行流端点清单：`downstreams` 模块集中维护对外暴露的端点，启动时按 openai / ollama / admin 顺序打印
- 新增 OpenAI Responses API 端点 `POST /v1/responses`：非流式返回 `object=response` + `output` 消息；`stream: true` 返回 SSE 事件流（response.created → in_progress → output_item.added → content_part.added → output_text.delta/done → content_part.done → output_item.done → completed）；网关边界经 `converters/responses-*.ts` 与 Chat Completions 互转，复用负载均衡 / 顺序回退 / 会话亲和
- 新增命令行 `--host` / `--port` 监听参数（支持 `--host=0.0.0.0` / `--port=8080` 等号形式）：优先级命令行 > 配置文件 `server` 节 > 缺省 `0.0.0.0:3000`；`scripts/start.js` 原样透传，根 `package.json` 新增 `"main": "scripts/start.js"`
- 监听参数解析：新增 `listen` 模块（命令行 `--host` / `--port` > 配置文件 `server` 节 > 缺省值 `0.0.0.0:3000`），`llmproxy.jsonc` 新增可选 `server{host,port}` 节
- 日志 stdout 镜像输出，便于 docker / tmux 等场景直接查看
- `/admin/api/health` 暴露 downstreams 与 host / port / baseUrl / listenSource；Dashboard 新增 Downstream Endpoints 区块与 Base URL 徽标
- 新增 Ollama `/api/version` 端点（Open WebUI 连接探测）
- start 脚本智能构建：`scripts/start.js` 产物存在时直接启动（跳过前端编译），新增 `start:rebuild` 强制全量构建

### 修复

- 修复会话键内容哈希对多模态内容（null / 数组 / 对象）的处理（JSON.stringify 参与哈希，字段缺失视为空串）
- 修复 Edge 浏览器最小化恢复时 `history.replaceState` 异常（页面隐藏时忽略）
- 修复下游返回模型 id 不正确的 Bug：`/v1/models` 与 `/api/tags` 此前返回上游原始模型名（导致 model_not_found），现改为返回下游别名列表

### 变更

- 日志记录方式重构：pino 迁移至 log4js（app 文本 / api JSON 按日轮转 + 文件保留期清理）
- 日志查询从文件反向读取改为 SQLite（删除 `readLogsTail`）；DB 日志清理规则与文件一致（保留 5 天）
- 网关默认监听 `0.0.0.0`（此前 `127.0.0.1` 导致外部无法访问）
- 移除环境变量 `HOST` / `PORT` 对监听地址的支持（改用命令行 `--host` / `--port`）
- 移除每 60 秒的 stats-snapshot 定时日志

### 安全

- 日志 SQLite 落库深度脱敏：`Authorization` / `x-api-key` 任意嵌套层级剔除

## [0.1.0] - 2026-08-02

- 单端口 LLM 网关：聚合 OpenAI 兼容上游，对外提供 OpenAI 兼容 `/v1` 与 Ollama 兼容 `/api` 两组入口 + 内置管理端
- 模型别名、轮询负载均衡、顺序故障回退、请求统计、内置管理界面
- 按日轮转日志（app 文本 / api JSON）

# Changelog

本项目所有值得记录的变更都会汇总到本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-08-19

### 新增

- **管理端登录会话鉴权**：
  - **全局挂载**：`adminAuth` 会话中间件统一挂到 `/admin/api/*`——白名单（`GET /admin/api/auth/salt` / `POST /admin/api/auth/login` / `GET /admin/api/auth/status` / `POST /admin/api/auth/logout` / `GET /admin/api/health`）外所有端点均要求有效登录会话，未登录统一 `401 { status: false, msg: '未登录或会话已过期', error: 'unauthenticated' }`（无 Cookie / 会话不存在 / 会话过期对外同形，防枚举）
  - **登录链路**：`GET /admin/api/auth/salt` 取 `{ salt, ts }` → `POST /admin/api/auth/login`（`{ username, passwordMd5: MD5(salt + ts + password), ts }`；`ts` 为 epoch 秒、±60s 防重放窗口）→ 成功 `200 { status: true, msg: 'ok', username }` + `Set-Cookie: llmproxy_admin_sid=<sessionId>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`（会话 24h、每次有效访问滑动续期）。失败：「用户不存在 / 已停用 / 密码错」同形 `401 invalid_credentials`；`ts` 超窗 `401 timestamp_expired`；缺参 `400 invalid_login`
  - **会话存储**：`admin_sessions` 表（SQLite，与 sessions / logs / api_keys 同库，WAL 多连接安全）；`session_id` 为 32 字节 CSPRNG hex（64 字符）不可猜测；服务端用配置明文密码重算同一摘要 + `crypto.timingSafeEqual` 恒时比较（防时序攻击）；Cookie 仅承载 sessionId，明文密码不落库、不落日志
  - **账号管理（需登录）**：`admins` 节存于 `llmproxy.jsonc`（`{ salt, accounts: [{ username, password, disabled, createdAt, lastLoginAt }] }`，权限 0600）；`GET /admin/api/admins`（掩码返回，仅 `hasPassword` 标记，绝不回显明文）/ `POST /admin/api/admins`（`201`，重名 `400 duplicate_username`，空 username/password `400 invalid_admin`；旧配置无 `admins` 节时顺带生成新 salt）/ `PATCH /admin/api/admins/:username`（`password` / `disabled` 任意子集；`password` 空串 = 保持原值；缺失 `404 admin_not_found`）/ `DELETE /admin/api/admins/:username`（禁止删自己 `cannot_delete_self`、禁止删最后一个启用中的账号 `last_admin`）；`POST /admin/api/auth/change-password`（需登录，旧密码摘要校验，错则 `400 wrong_old_password`）
  - **登出**：`POST /admin/api/auth/logout`（幂等，无会话也清 Cookie 返回 `ok`）
  - **测试**：`test/server/admin-protection.test.ts`（65 例）覆盖白名单外全端点「无会话 → 401 / 持会话 → 放行」+ 白名单免登录 + 完整登录链路（正确 / 错误凭据）+ 伪造会话 → 401

- **默认管理员自愈（现有配置缺 admins 节）**：`llmproxy.jsonc` 已存在但 `admins` 节缺失 / `accounts` 为空时（旧配置升级场景），启动自动创建默认账号 `admin` + 随机初始密码（16 位 base32）并保留既有 salt（无则新生成 64 位 hex）；初始密码仅启动时打印一次到控制台 + warn 日志（`Default admin created (no existing admins found). username=admin password=<随机> — please change immediately after first login.`），此后不再可得；已有账号的现有配置不受影响（避免覆盖）。`test/config/store.test.ts` 新增 4 例覆盖「缺失 / 空 / 已有账号 / salt 保留与生成」

- **API Key 鉴权（Bearer Token）**：
  - **配置开关**：`llmproxy.jsonc` 新增 `auth` 节（`{ enabled?: boolean, keyBytes?: number, cleanupRetentionDays?: number }`，缺省 `disabled`）。全局开关开启时，所有 `/v1/*`（含 `/v1/models`/`/v1/chat/completions`/`/v1/responses`/`/v1/embeddings`/`/v1/rerank`）与 `/api/*`（含 `/api/version`/`/api/tags`/`/api/chat`/`/api/show`）请求必须携带 `Authorization: Bearer <key>`，否则返回 401。管理端 `/admin/api/*` 不受本开关影响（另有独立的登录会话鉴权，见上条）。开关读取每次请求走 `store.get()`，支持热更新；关闭时中间件完全旁路、零 IO
  - **API Key 存储**：新增 `api_keys` 表（SQLite，与 sessions/logs 表共存于 `~/llmproxy/llmproxy.db`），字段 `id / name / key_hash (SHA-256) / key_prefix (前 8 字符) / created_at / expires_at (0=永不过期) / last_used_at / disabled`。明文 Key 仅创建时一次性返回；DB 仅存哈希 + 前缀（用于 UI 识别），单向不可逆。`last_used_at` 鉴权成功后异步触摸（失败仅告警，不阻断业务）
  - **过期清理（保留期可配）**：`api_keys` 表每天一次清理已过期 Key，保留期由 `auth.cleanupRetentionDays` 控制（缺省 7 天；`0` 表示过期即清理；范围 `0-3650`）。SQL 改为 `expires_at > 0 AND expires_at < (now - retentionDays * 86400000)`：刚过期但仍在保留期内的记录保留供审计，超过保留期才被清理。启动期与每次清理周期均读最新配置（热更新无需重启）。过期与「不存在/已停用」在鉴权层用相同 401 文案（`invalid_api_key`），仅服务端 `code` 字段细分（`unknown_api_key` / `expired_api_key`），避免客户端枚举 Key 状态
  - **管理端 CRUD**：`GET /admin/api/keys`（分页：`offset/limit`、`keyword` 模糊匹配 name/key_prefix、`includeDisabled=true` 包含停用记录）；`POST /admin/api/keys`（`{ name, expiresAt }`，返回 `{ id, name, apiKey (明文一次), keyPrefix, expiresAt, disabled, createdAt }`）；`PUT /admin/api/keys/:id`（`name / expiresAt / disabled` 任意子集）；`DELETE /admin/api/keys/:id`（幂等）；`GET /admin/api/auth/status`（`{ enabled, total }`，供前端开关切换前的提示）。`expiresAt <= now` 返回 400 `invalid_expires_at`
  - **管理端 UI**：「API Keys」页面（侧边栏新增入口 + 路由 `/api-keys`）：顶部鉴权状态卡（开关 + Key 数）+ 列表（名称 / 前缀 / 过期时间 / 创建时间 / 状态标签：正常/已停用/已过期）+ 分页器（10/20/50/100，total 与服务端一致）+ 新建弹窗（name 必填 + 永不过期/日期选择器切换 + 创建结果明文一次弹窗，提示立即复制保存）+ 编辑弹窗（name / 过期时间）+ 启用/停用切换 + 删除确认
  - **响应包络**：鉴权 401 响应遵循 OpenAI 风格 `{ error: { message, type: 'invalid_request_error', code: 'invalid_api_key' }, code: '<细因>' }`，附 `WWW-Authenticate: Bearer realm="llmproxy"` 响应头；敏感字段（明文 Key）绝不入日志（requestLogger 已过滤 `authorization`，且 `LogStore` 的 `sanitizeRawValue` 兜底；DB 中只存 SHA-256 哈希）
  - **配置文件 bootstrap**：自动生成的 `llmproxy.jsonc` 中新增 `auth` 节注释示例（关闭状态）

## [0.5.1] / 2026-08-08

### 新增

- **POST /rerank 与 /v1/rerank 重排序透传代理**：OpenAI 兼容下游新增文本重排序端点（`/v1/rerank` 为 `/rerank` 的同义路径，两路径共享同一 handler）。按 `/v1/embeddings` 模式实现：别名解析 → 轮询起点 → 顺序回退；仅改写 model 为上游侧模型名，其余字段原样透传；不走会话亲和（不写 sessions 表）；上游 404 视为不支持 → 可回退，其余 4xx 立即中断；全部失败返回 502 no_upstream。JSON body 上限由 server.bodyLimit 配置，见下条
- **下行端点清单**：DOWNSTREAM_ENDPOINTS 与 /admin/api/health 新增 POST /rerank 与 POST /v1/rerank 条目
- **server.bodyLimit 可配置 JSON body 上限**：server{} 节新增 bodyLimit（缺省 '10mb'，支持 '10mb' 字符串或数字字节数），全局生效（所有接口共用）；进程级配置，修改后需重启；非法 limit 值（如 'abc'）会导致启动失败；ServerListenSchema 更名为 ServerConfigSchema
- **Ollama `POST /api/show` 模型详情端点**：按 Ollama 官方契约实现。请求体 `{ model }`（可选 `verbose`），响应含 `license` / `modelfile` / `parameters` / `template` / `details`（openai 占位）/ `model_info`（`general.architecture: "openai"`，并按别名分组内候选 `max_context_length` 聚合最小值输出 `openai.context_length`）/ `capabilities`（候选配置的并集，无配置为空数组）/ `modified_at`。**不代理上游**：数据全部来自 `downstreamModels` 别名配置。`model` 缺失或非字符串返回 `400 { error: 'invalid_request', field: 'model' }`；别名未配置返回 `404 { error: 'model_not_found' }`
- **下行端点清单新增 `POST /api/show`**：`DOWNSTREAM_ENDPOINTS` 与 `/admin/api/health` 自动包含新条目
- **下行候选 `capabilities` 字段**：`UpstreamCandidateSchema` 新增 `capabilities?: z.array(z.string())`（自由字符串，无枚举约束；Ollama 生态常用值：`completion` / `vision` / `tools` / `thinking` / `embedding` / `insert` / `audio` 等，扩展友好）。别名聚合语义：候选并集，按首次出现顺序去重；某别名任一候选配置非空数组即纳入聚合。`GET /api/tags` 在每个模型条目附加 `capabilities`（与 Ollama 较新版本对齐）；`GET /v1/models` 不附加（OpenAI 路径保持纯净，只在有 n_ctx 时附加 `meta`）。管理端 Models 页面每个候选行新增「能力」多选下拉（Element Plus `el-select multiple` + `allow-create`，支持选择 7 个预设能力 + 键入自定义字符串回车添加），保存时只在非空时下发，刷新页面自动回填
- **会话键新增 github client 类型**：`session/key.ts` 会话键优先级新增第 3 级——HTTP header `baggage` 存在且其值（转小写后）包含子串 `copilot`（GitHub Copilot 等 client 的标识，典型值如 `vs.copilot.InitiatorType = user`）→ 命中；此时会话键取「第 1 个 assistant 之前」的所有消息（无 assistant 则取全部）的 `[role, content]` 二元组 JSON.stringify 后 sha256，client 标记 `github`。新优先级：`X-OpenWebUI-Chat-Id` → `X-Session-Id` → baggage/copilot → 内容前缀 hash → 轮询兜底
- **管理端新增 `GET /admin/api/session-clients` 端点**：返回会话粘附库中出现的去重 client 类型（按字母序，空库返回 `[]`）；Sessions 页客户端筛选下拉改为动态获取，不再硬编码 client 枚举
- **会话键 header 查找性能优化**：`findHeaderValue` 改为一次性规范化「小写 key → 首个值」Map 后 O(1) 查找；顺带移除调试用 console.log 与 printHeaders 参数

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

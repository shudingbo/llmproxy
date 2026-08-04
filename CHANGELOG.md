# Changelog

本项目所有值得记录的变更都会汇总到本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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

# 快速开始

llmproxy 是一个单端口的 LLM 网关：把多个 OpenAI 兼容上游（OpenAI、DeepSeek、Ollama 等）聚合成统一的 OpenAI（`/v1`）与 Ollama（`/api`）兼容入口，支持模型别名、负载均衡、会话亲和路由、顺序回退、API 统计，并内置一个管理界面。

## 环境要求

- **Node.js ≥ 18**（`engines` 约束）。建议使用 20+，项目依赖的 `better-sqlite3` 需要较新的 Node 版本才能获得预编译二进制，避免本地编译。
- **pnpm 9.x**：仓库固定 `packageManager: "pnpm@9.15.4"`。可用 corepack 启用（`corepack enable`），或 `npm i -g pnpm@9` 对齐版本。
- 操作系统不限（Windows / Linux / macOS 均可），SQLite 数据由 `better-sqlite3` 提供，无需额外安装数据库。

## 安装

在项目根目录执行：

```bash
pnpm install
```

仓库是 pnpm workspace，包含两个包：`server`（Node.js/Express 服务端）与 `web`（Vue 3 管理端），根 `package.json` 只提供统一脚本。

## 启动

### 开发模式

```bash
pnpm dev
```

同时启动两个进程：

| 进程 | 端口 | 说明 |
| --- | --- | --- |
| server | `3000` | `tsx watch src/index.ts`，改代码自动重启 |
| web | `5175` | Vite dev server，提供管理界面；`/admin/api` 请求由 Vite 代理到 `127.0.0.1:3000` |

开发期访问管理界面走 `http://127.0.0.1:5175`；直接调 `/v1`、`/api` 接口走 `http://127.0.0.1:3000`。

开发模式下如需指定监听地址 / 端口，直接跑 server 包并透传参数（`tsx watch` 会把 `--` 后的参数原样传给被监听脚本）：

```bash
pnpm --filter @llmproxy/server dev -- --host 0.0.0.0 --port 8080
```

### 生产模式

```bash
pnpm build   # 先构建 web（vue-tsc + vite build），再构建 server（tsc），产物在 server/dist 与 web/dist
pnpm start   # 启动服务
```

`pnpm start` 是**智能构建启动**（`node scripts/start.js`）：

- 检查 `server/dist/index.js` 与 `web/dist/index.html` 两个产物；**存在则跳过构建直接启动**，秒启。
- 产物缺失时才构建对应部分（server 缺失构建 server，web 缺失构建 web）。
- `pnpm start:rebuild`：先强制 `pnpm build` 全量构建再启动，用于代码更新后想确保产物最新时。
- `pnpm start --check`：只检查产物存在性并打印结果，不构建不启动（可加 `--rebuild` 一起看）。

> 首次使用直接执行 `pnpm start` 即可，它会自动补建缺失的产物。

指定监听地址 / 端口：`--host` / `--port` 会被 `start.js` 原样透传给服务进程（也支持 `--host=0.0.0.0` / `--port=8080` 等号形式）：

```bash
pnpm start -- --host 0.0.0.0 --port 8080
# 或直接跑服务进程
node scripts/start.js --host 0.0.0.0 --port 8080
```

## 配置文件

首次启动会在用户主目录下自动生成带注释的示例配置：

```
~/llmproxy/llmproxy.jsonc   # 配置文件（JSONC，支持注释与尾逗号，权限 0600）
~/llmproxy/llmproxy.db      # SQLite 数据库（sessions 会话粘附表 + logs 日志表，WAL 模式）
~/llmproxy/logs/            # 日志文件目录（app-YYYY-MM-DD.log / api-YYYY-MM-DD.log）
~/llmproxy/log4js.json      # log4js 日志行为配置（可手动编辑调整 appender）
```

- Windows 下 `~` 为 `%USERPROFILE%`（如 `C:\Users\<you>\llmproxy\`）。
- 配置被文件监听热重载，**修改保存即生效，无需重启**（仅 `server` 节监听参数除外，见下）。
- 示例配置中的 `apiKey` 默认是 `sk-REPLACE_ME`，请替换成真实密钥。
- 配置内容结构：`upstreams[]`（上游列表）、`downstreamModels`（别名 → 有序候选）、`server`（可选监听参数）、`routing`（可选，会话亲和）。完整字段见根目录 `README.md` 的 Config 章节。

配置示例：

```jsonc
{
  // max_context_length 为可选：模型最大上下文，可手动设置或管理端「自动」按钮探测（llama.cpp / LM Studio），缺省不设
  "upstreams": [
    { "id": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "timeoutMs": 30000, "max_context_length": 32768 },
    { "id": "ollama-local", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "dummy" }
  ],
  "downstreamModels": {
    "my-alias": [
      { "upstreamId": "openai", "model": "gpt-4o-mini" },
      { "upstreamId": "ollama-local", "model": "qwen2.5:7b" }
    ]
  },
  "server": { "host": "0.0.0.0", "port": 3000 }
}
```

## 服务地址与访问

网关单端口对外提供全部能力：

| 地址 | 用途 |
| --- | --- |
| `http://<host>:3000/` | 管理界面（左侧导航 6 个页面） |
| `http://<host>:3000/v1` | OpenAI 兼容接口（`/v1/models`、`/v1/chat/completions`、`/v1/responses`） |
| `http://<host>:3000/api` | Ollama 兼容接口（`/api/tags`、`/api/chat`、`/api/version`） |
| `http://<host>:3000/admin/api` | 管理 REST 接口（全局登录会话鉴权——白名单 `/auth/salt` / `/auth/login` / `/auth/status` / `/auth/logout` / `/health` 外均需登录会话，未登录 `401`） |

**监听地址**（`server/src/server/listen.ts`）按优先级取：

1. 命令行参数 `--host` / `--port`（最高优先级；host/port 相互独立可选，未指定的一侧回落下一优先级；也支持 `--host=0.0.0.0` / `--port=8080` 等号形式）
2. 配置文件 `server` 节（`host` / `port`）
3. 缺省值 `0.0.0.0:3000`（即监听所有网卡，局域网内其他机器可通过本机 IP 访问）

> 已不再支持环境变量 `HOST` / `PORT` 覆盖监听地址（改用命令行 `--host` / `--port`）。

```bash
# 用命令行参数覆盖端口 / 监听地址（start.js 会把 --host/--port 原样透传给服务进程）
pnpm start -- --host 0.0.0.0 --port 8080
node scripts/start.js --host 127.0.0.1 --port 8080
```

> 注意：`server` 节的 host/port 与命令行参数都在进程启动时绑定，修改后必须重启进程才生效；`routing`、`upstreams` 等其余配置支持热重载。

## 冒烟测试

```bash
# OpenAI 兼容（返回 OpenAI 风格 choices）
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}]}'

# Ollama 兼容（返回 Ollama 风格 message）
curl http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model": "my-alias", "messages": [{"role": "user", "content": "hi"}], "stream": false}'
```

请求里的 `model` 一律填**下游别名**（`downstreamModels` 的键），不是上游真实模型名。两个端点都支持 `"stream": true`（OpenAI 输出 SSE，Ollama 输出 NDJSON）。

## 其他脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm test` | 全部工作区单元测试（vitest） |
| `pnpm lint` | 全部工作区 lint（eslint） |
| `pnpm typecheck` | 全部工作区类型检查（server `tsc --noEmit`、web `vue-tsc --noEmit`） |

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `EADDRINUSE` | 端口被占用。停掉占用进程，或换端口启动：`pnpm start -- --port <新端口>` |
| 管理界面返回 `503 {"error":"admin_ui_not_built"}` | `web/dist` 缺失。执行 `pnpm --filter @llmproxy/web build`，或直接 `pnpm start` 自动补建 |
| 请求返回 404 / unknown model | `model` 里的别名未在 `downstreamModels` 定义，检查配置文件或管理端 Models 页 |
| 上游不可达返回 502 | 在管理端 Upstreams 页点「测试」检查 `baseUrl` 连通性、`apiKey`、`timeoutMs` |
| 日志不在终端输出 | 预期行为：日志写文件（`~/llmproxy/logs/`）与 SQLite，管理端查询走 SQLite |

## 下一步

- 管理界面的日志页用法见 [logs-page.md](./logs-page.md)
- 会话亲和粘附映射的管理见 [sessions-page.md](./sessions-page.md)
- 对接 Open WebUI 见 [open-webui-integration.md](./open-webui-integration.md)

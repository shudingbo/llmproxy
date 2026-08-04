# AGENTS.md — llmproxy

> 单端口 LLM 网关：聚合多个 OpenAI 兼容上游，对外暴露 OpenAI / Ollama / 管理端三套接口。下面只列 agent **容易踩坑** 的事实，可执行命令以根 `package.json` 为准。

## 1. 仓库结构（pnpm workspace）

- 两个子包：`server`（`@llmproxy/server`，Express 5 + TypeScript ESM）与 `web`（`@llmproxy/web`，Vue 3 + Element Plus + Pinia）。根 `package.json` 只放聚合脚本，没有业务代码。
- Node ≥ 22（`better-sqlite3@13.x` 强制要求；旧版 Node 18/20 已不支持），固定 `packageManager: pnpm@9.15.4`。本仓库 `npm` / `yarn` 不可用。
- ESM（`type: "module"`），TS `NodeNext` 模块解析：**跨文件 import 必须带 `.js` 后缀**（如 `import { getLogger } from '../logger/index.js'`），运行时不会自动加。

## 2. 数据目录（**不在 repo 内**，最容易踩坑）

所有运行期产物落在用户主目录下：

```
<userHome>/llmproxy/
├── llmproxy.jsonc     # 配置（JSONC：支持注释 / 尾逗号，0600 权限），首次运行自动生成
├── llmproxy.db        # SQLite（WAL），含 sessions 表（会话粘附）+ logs 表（双写）
├── logs/              # app-YYYY-MM-DD.log（文本）+ api-YYYY-MM-DD.log（JSON）
└── log4js.json        # 首次启动自动写入默认值，可手动编辑
```

仓库根 `.npmrc` 设了 `ignore-scripts=true`：better-sqlite3 v13.0.2 自带 prebuilds（`package/prebuilds/*.node`），`require()` 时由 `lib/binding.js` 直接按 `process.platform-arch` 加载，**无需 install script 触发 node-gyp 编译**。该配置同时兼容 npm / pnpm，规避 npm publish 时隐式注入 `"install": "node-gyp rebuild"` 后触发 `find VS` 失败的 bug（[WiseLibs/better-sqlite3#1503](https://github.com/WiseLibs/better-sqlite3/issues/1503)）。

- 想「重置」就是删这个目录；新克隆仓库后 **没有任何 llmproxy.jsonc**，需要先 `pnpm start` 让它 bootstrap。
- 配置文件由 `chokidar` 监听热重载，**不需重启**。新增 / 禁用上游即时生效（见 `server/src/server/index.ts` 的 `rebuildClients`）。
- 配置变更后非法时保留旧值并通过 `GET /admin/api/config/reload-error` 上报。

## 3. 命令速查（根目录）

| 命令 | 行为 |
| --- | --- |
| `pnpm install` | 安装 workspace 依赖 |
| `pnpm dev` | concurrently 启动 server（`tsx watch`，3000）+ web（vite，**5175**，见 §6） |
| `pnpm start` | **智能构建**：`server/dist/index.js` 与 `web/dist/index.html` 缺失才构建，存在则直接 `node server/dist/index.js` 启动 |
| `pnpm start:rebuild` | 强制 `pnpm build` 后再启动 |
| `pnpm start -- --host 0.0.0.0 --port 8080` | 等号形式 `--host=...` 也可；这些参数原样透传给 server 进程 |
| `pnpm build` | 先 web（`vue-tsc --noEmit && vite build`）后 server（`tsc`） |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | 递归跑两个 workspace，递归到 `pnpm -r <script>` |
| `pnpm --filter @llmproxy/server test:integration` | 仅跑集成测试 `test/server/integration.test.ts`（supertest 打真实应用） |

服务进程监听优先级（`server/src/server/listen.ts`）：**CLI `--host`/`--port` > `llmproxy.jsonc` 的 `server{}` 节 > 缺省 `0.0.0.0:3000`**；host / port 互相独立可选。**已不再支持环境变量 `HOST` / `PORT`**，别再尝试。

## 4. 测试（server 子包）

- 框架 `vitest` v4（Node ESM），配置文件 `server/vitest.config.ts`：`include: ['test/**/*.test.ts']`。
- **测试在 `server/test/` 下镜像 `server/src/` 子目录结构**（不是 co-locate 在 `src/`）。新增测试就在 `server/test/<对应模块>/` 加 `*.test.ts`。
- 临时数据库 / 数据目录一律走 `tmpdir()` + `randomBytes` 唯一文件名，关闭连接后清理 `-wal` / `-shm`（logger 测试 `vi.resetModules()` + `vi.stubEnv('HOME', tmp)`）。详见 `docs/development/testing.md`。
- 已知环境限制：`test/config/watcher.test.ts`（4 例）与 `test/server/integration.test.ts`（15 例）会因 inotify 上限过低报 `EMFILE: too many open files`。在本机需要排除：
  ```bash
  cd server && npx vitest run \
    --exclude 'test/config/watcher.test.ts' \
    --exclude 'test/server/integration.test.ts'
  ```
  或用 root 临时 `sysctl fs.inotify.max_user_instances=512`。基线 287 例全绿 + 19 例受限。
- web 子包**没有单测**，质量门禁是 `vue-tsc --noEmit`（已在 `pnpm build` 内含）。

## 5. 单端口架构

```
express 应用（单进程，单端口）
├── express.json({ limit: '10mb' })
├── requestLogger（requestId + 结构化请求日志，敏感头脱敏）
├── /admin/api/*     registerAdminRoutes（admin.ts）
├── /v1/*            registerOpenAIRoutes（/v1/models、/v1/chat/completions、/v1/responses）
├── /api/*           registerOllamaRoutes（/api/version、/api/tags、/api/chat）
├── express.static(webDistPath)
└── SPA 回退：非以上前缀的 GET → index.html（产物缺失时返回 503 { error: 'admin_ui_not_built' }）
```

- `/api/chat` 的 `n > 1` **直接 400**；`/api/show`、`/api/generate`、`/api/embed` 等未实现。
- `/v1/responses` 在网关边界做 Responses ↔ Chat Completions 互转（`server/src/converters/responses-*.ts`），复用同一套回退 / 粘附逻辑。

## 6. 路由、负载均衡、回退（最容易改错的地方）

- 模型请求里 `model` 字段**永远是下游别名**（`downstreamModels` 的 key），不是上游原始模型名。`/v1/models` 和 `/api/tags` 返回的也是别名列表（已修复过上游模型名泄漏 Bug，见 CHANGELOG 0.2.0）。
- 别名解析（`Router.resolve`）过滤 `disabled: true` 上游；别名不存在抛 `ModelNotFoundError`；某别名全候选被暂停时**记警告并按原列表返回**，交回退决策。
- 负载均衡：默认启开会话亲和（`routing.sessionAffinity.enabled` 缺省 `true`，判断是 `!== false`）。**总开关在启动时确定，不做热更新重选**——改完要重启。
- 会话键来源（`server/src/session/key.ts`）：`X-OpenWebUI-Chat-Id` header > `messages` 前 2 条 sha256 哈希 > 退轮询。
- 回退条件（`isFallbackableAxiosError`，`server/src/router/fallback.ts`）：网络错误 `ECONNREFUSED / ETIMEDOUT / ECONNRESET / ENOTFOUND`、上游超时、`429`、`5xx` 可回退；其余 `4xx`（`401/403/404` 等）**不可回退，立即中断**。全部失败返回 `502 { error: 'no_upstream' }`。
- 流式中止用 `res.on('close')` 自建 `AbortController`，**别用 `req.on('close')`**——后者在请求体被消费完就触发，会误中止。

## 7. 上下端点单一真相源

新增 / 删减下游路由时，改 `server/src/server/downstreams.ts` 的 `DOWNSTREAM_ENDPOINTS`：启动日志打印与 `/admin/api/health` 都从这里读，不需要改两处。

## 8. 日志双写（`server/src/logger/index.ts`）

- log4js 双类别 `app`（文本 pattern layout）+ `api`（JSON 行，兼容原 pino 契约），按本地日期分文件 + stdout 镜像。
- **装配时 `setLogStore(logStore)` 之后 `getLogger()` 返回 Proxy 包装**，同步写 SQLite；写入失败 `try-catch` 隔离只告警一次，**不影响文件日志也不抛业务错误**。
- 敏感头：`authorization` / `x-api-key`（任意嵌套层级）一律不入文件、不入库。`server/src/server/admin-helpers.ts` 的 `maskApiKey` 保留后 4 位。
- 保留期 5 天（`RETENTION_DAYS`），启动一次 + 每 6 小时清理（`server/src/logger/sweep.ts` 与 `server/src/logstore/index.ts` 同步）。

## 9. API Key 行为（硬约束）

- **绝不**写日志（文件侧过滤头 + SQLite `sanitizeRawValue` 深度剔除双重保险）。
- **绝不**转发客户端 `Authorization` 到上游——上游鉴权头只来自配置的 `apiKey`。
- **绝不**以明文回显：`/admin/api/upstreams` 系列 apiKey 一律掩码返回；编辑时留空 = 保持原值。

## 9.5. 模型上下文长度（`max_context_length`）

字段位置：**`UpstreamCandidate`（候选层）**，不在 `Upstream`。原因：同一上游跑不同模型时各自的 n_ctx 不同（LM Studio 同时加载 qwen2.5:7b-base 32k + llama3.1:8b 128k），按候选粒度配置。

探测端点：`POST /admin/api/candidates/probe-context`，body 必传 `upstreamId` + `model`（候选身份），`baseUrl`/`apiKey` 缺省从配置上游取，非空字符串覆盖。

聚合语义（`server/src/server/model-meta.ts`）：别名分组内候选 `max_context_length` 取**最小值**作为对外 `n_ctx`，全部未配置则该别名无 meta。

## 10. 前端要点（`web/`）

- Vue 3 + `<script setup>` + 组合式 API（项目偏好）。Element Plus 图标按需自动注册（`unplugin-auto-import` + `unplugin-vue-components`），**不要手动 `import { ElButton } from 'element-plus'`**。`web/auto-imports.d.ts` 与 `web/components.d.ts` 由插件生成，**这两文件可空 / 可忽略手工编辑**。
- vite dev port = `5175`（`web/vite.config.ts`，**README 写 5173 是过期的，以 vite 配置为准**），`/admin/api` 自动代理到 `http://127.0.0.1:3000`。
- 路由表在 `web/src/router.ts`（6 个页面挂在 `AdminLayout` 下，全部懒加载）；菜单项 `web/src/layouts/AdminLayout.vue` 与路由表一一对应。
- `@/*` → `src/*`（`web/tsconfig.json` paths）。

## 11. 错误返回格式与日志约定

- 管理端与上游错误响应统一 `{ status: boolean, msg: string, ... }`（项目惯例，admin 路由大体遵循）。
- 异步数据库操作必须 `try-catch`，错误先 `this.app.logger.warn('上下文', error)` 再返回。
- 代码注释用中文，命名 / 技术术语保留英文。

## 12. 关联文档（按需深入）

- `docs/architecture/overview.md`：完整架构、数据流、回退与日志细节
- `docs/architecture/session-affinity.md`：会话亲和路由专题
- `docs/architecture/logging.md`：日志双写专题
- `docs/development/modules.md`：模块地图（注意：旧版本提到「测试与源码同目录」以 `vitest.config.ts` 为准 → **`test/` 下**）
- `docs/development/testing.md`：测试编写约定 + inotify 受限处理
- `docs/configuration.md`：`upstreams` / `downstreamModels` / `routing` 字段权威说明
- `CHANGELOG.md`：每次变更要点（K&R 风格 Keep a Changelog）

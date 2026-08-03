# 测试指南（testing.md）

> 本文基于当前代码与已验证的测试运行结果编写。测试基线已在本机实际运行确认。

## 1. 测试框架

| 包 | 框架 | 说明 |
| --- | --- | --- |
| `server`（@llmproxy/server） | [vitest](https://vitest.dev) v4 | Node 环境 + ESM，测试文件与源码同目录（`src/**/*.test.ts`），v8 覆盖率 |
| `web`（@llmproxy/web） | `vue-tsc --noEmit` | 前端当前无单元测试，质量门禁是 TypeScript 类型检查 |

server 的 vitest 配置（`server/vitest.config.ts`）：

- `environment: 'node'`（无 DOM 需求）
- `include: ['src/**/*.test.ts']`
- `passWithNoTests: true`
- 覆盖率 provider 为 `v8`，reporter 为 `text` + `html`

## 2. 常用命令

### 2.1 server 测试

```bash
cd server

# 全量测试（默认排除受限文件，见 §4）
pnpm test

# 单文件 / 指定文件测试
pnpm test src/session/db.test.ts
pnpm test src/router/load-balancer.test.ts src/config/store.test.ts

# 监听模式（改代码自动重跑）
pnpm test:watch

# 集成测试（单独运行）
pnpm test:integration

# 类型检查
pnpm typecheck

# lint
pnpm lint
```

> 说明：`pnpm test` 执行的是 `vitest run`，后面追加文件路径即为文件过滤；`pnpm test:watch` 执行 `vitest`（默认监听）。根目录执行 `pnpm test` 会递归运行全部 workspace 子包的 `test`。

### 2.2 web 类型检查

```bash
cd web

# 类型检查（vue-tsc）
npx vue-tsc --noEmit
# 等价：pnpm typecheck

# 构建（含类型检查 + vite build）
pnpm build
```

## 3. 测试文件分布（server/src）

测试文件与源码同目录存放，按主题一一对应：

| 目录 | 测试文件 | 覆盖主题 |
| --- | --- | --- |
| `src/` | `paths.test.ts` | 路径推导、按日日志文件名、目录创建 |
| `src/config/` | `schema.test.ts` | Zod 模式校验、缺省值补齐 |
| | `loader.test.ts` | JSONC 解析（注释 / 尾逗号）、PARSE / VALIDATE 错误分类 |
| | `store.test.ts` | bootstrap 写入、round-trip、深比较去重、订阅通知、原子持久化 |
| | `watcher.test.ts` | 文件变更自动重载、非法配置保留旧值（⚠ 本机受限，见 §4） |
| `src/router/` | `router.test.ts` | `Router.resolve` 别名映射、disabled 过滤 |
| | `load-balancer.test.ts` | RoundRobin 轮询、SessionAffinity 粘附 / 重绑 / 无会话键兜底 |
| | `fallback.test.ts` | `executeWithFallback` wrap 顺序、fallbackable 判定、尝试日志 |
| `src/session/` | `key.test.ts` | 会话键提取：header 优先、内容前缀 hash、边界情况 |
| | `db.test.ts` | SessionStore：绑定 / 触摸 / 改绑 / 分页 / 清理 / 重开持久化 |
| `src/logstore/` | `index.test.ts` | LogStore：插入（可选字段存 NULL）/ 查询过滤 / 清理 / 重开持久化 |
| `src/logger/` | `index.test.ts` | log4js 双类别配置、按日分文件、stdout 镜像、JSON/text 契约、requestLogger、SQLite 双写 |
| | `sweep.test.ts` | 日志文件保留期清理、手动清理、定时器启停 |
| `src/stats/` | `counter.test.ts` | 请求 / 错误 / 耗时聚合、快照、since 覆盖 |
| `src/upstream/` | `openai.test.ts` | 上游客户端：模型列表、非流式、流式（connectError / abort） |
| `src/converters/` | `openai-to-ollama-models.test.ts` | 模型列表映射、占位元数据 |
| | `openai-to-ollama-request.test.ts` | 请求转换：消息 / 多模态 / 采样参数 / response_format |
| | `openai-to-ollama-response.test.ts` | 非流式响应映射、finish_reason、usage |
| | `openai-to-ollama-stream.test.ts` | SSE → NDJSON 流转换：跨 chunk 拼接、usage 捕获、done 唯一 |
| `src/server/` | `admin-helpers.test.ts` | maskApiKey、scrubSensitiveKeys |
| | `admin.test.ts` | 管理端 API：上游 CRUD / 测试 / 下游映射 / 日志 / 统计 / 会话 / 健康检查 |
| | `downstreams.test.ts` | 端点清单结构 |
| | `listen.test.ts` | `resolveListen` 优先级：env > config > 缺省 |
| | `openai.test.ts` | `/v1` 路由：模型列表、非流式 / 流式透传、回退、404 / 502 |
| | `ollama.test.ts` | `/api` 路由：tags / chat、转换链、n > 1 拒绝 |
| | `index.test.ts` | `createApp` 装配：中间件顺序、静态产物、SPA 回退 |
| | `integration.test.ts` | 端到端集成（⚠ 本机受限，见 §4） |

## 4. 已知环境限制：inotify 上限（与代码无关）

### 4.1 现象

`src/config/watcher.test.ts`（4 例）与 `src/server/integration.test.ts`（15 例）在本机运行时报：

```
EMFILE: too many open files, watch '...'
```

原因是 chokidar 创建 `fs.watch` 失败。这两个文件在**未修改任何代码**的情况下单独运行同样失败，与会话亲和 / 日志改造等近期改动无关（问题记录见 `.omo/notepads/session-affinity-routing/issues.md`）。

### 4.2 根因

系统 inotify 实例上限过低：

```
/proc/sys/fs/inotify/max_user_instances = 128
当前已用 ≈ 180（trae 编辑器、weather-mcp、nrs-mcp、playwright daemon 等常驻进程占用）
```

进程超出配额后无法再创建 inotify 实例，chokidar 的文件监听即失败。

### 4.3 处置方式（全量测试）

全量测试需排除这两个文件：

```bash
cd server
npx vitest run \
  --exclude 'src/config/watcher.test.ts' \
  --exclude 'src/server/integration.test.ts'
```

`pnpm test` 直接全量运行时，如果这两个文件被匹配，会因环境问题失败；在受限环境下请按上述排除方式执行。

### 4.4 根治办法

任选其一（需要 root 权限或关闭部分常驻进程）：

```bash
# 提高系统 inotify 实例上限（重启后失效，可写入 sysctl.conf 持久化）
sudo sysctl fs.inotify.max_user_instances=512

# 或：关闭部分占用 inotify 实例的常驻进程（trae / mcp daemon / playwright 等）
```

提升上限后即可运行全部测试（含 watcher 与 integration），无需改代码。

## 5. 测试基线

在本机（inotify 受限环境下）排除 `src/config/watcher.test.ts` 与 `src/server/integration.test.ts` 后实际运行结果：

```
Test Files  25 passed (25)
      Tests  287 passed (287)
```

- **基线：287 tests / 25 个测试文件，全绿**
- 受环境限制未纳入基线的两个文件：`watcher.test.ts`（4 例）、`integration.test.ts`（15 例）
- 若环境上限已提升、全量运行，总测试数应为 287 + 4 + 15 = **306**（其中 watcher 用例依赖 chokidar 文件监听）

## 6. 编写风格约定

新测试遵循现有测试文件的风格：

- **命名**：`describe` 块用被测对象名（英文，如 `describe('SessionStore', ...)`、`describe('extractSessionKey', ...)`）；`it` 用例描述用中文，写清场景与预期（如 `it('header 存在（大小写不敏感 X-OPENWEBUI-CHAT-ID）→ 返回 header 值、client=open-webui', ...)`）。
- **临时 DB**：涉及 SQLite（session / logstore / logger 双写）的测试一律用 `tmpdir()` 下的随机文件（`randomBytes` 生成唯一名），`afterEach` 中关闭连接并删除 `db` / `-wal` / `-shm` 伴生文件，避免污染真实数据与跨用例干扰。
- **时间控制**：涉及 `Date.now()` 断言的测试（如 `updated_at` 递增、sweep 过期）用真实短 sleep 推进时钟，或用 `vi.useFakeTimers({ toFake: ['Date'] })` 只假时钟不动定时器（logger 测试）。
- **单例隔离**：log4js / 环境变量是模块级状态，logger 测试用 `vi.resetModules()` + 动态 `import()` 获取全新模块实例，并用 `vi.stubEnv('HOME' / 'USERPROFILE', tmp)` 把数据目录指到临时目录。
- **HTTP 断言**：路由 / 装配层测试用 `supertest` 直接打 Express 应用，不真实起监听端口。
- **流式测试**：上游流式客户端 / SSE 转换的测试直接用构造的 `Readable` 模拟上游字节流，并等待异步完成（`await` promise 或轮询 buffer）。

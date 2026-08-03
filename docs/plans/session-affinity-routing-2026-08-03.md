# 会话亲和路由（Session Affinity Routing）实施计划

> 归档日期：2026-08-03
> 状态：已完成（全部 9 项任务完成，最终回归通过并实测验证）

## 目标

同一会话（基于内容前缀 hash 或 Open WebUI chat_id）的请求粘附到同一上游，最大化 LLM prompt cache 利用率。探测失败（无会话键）时回退现有轮询。

## 已确认决策

来源：`.omo/plans/session-affinity-routing.md` + `.omo/notepads/session-affinity-routing/learnings.md`

- 会话亲和键优先级：Open WebUI header `X-OpenWebUI-Chat-Id` 优先（client='open-webui'）；否则取内容前缀 hash（messages.slice(0,2) 的 [role, content]，sha256，client='content-hash'）
- 无会话键的请求回退现有 RoundRobin 轮询，行为不变（opencode 等不传会话标识的 client 走轮询兜底）
- 存储：better-sqlite3，路径 `~/llmproxy/llmproxy.db`（复用 paths.ts getDataDir()）
- 亲和键粒度：`sessionKey = ${downstreamModel}::${raw}`，按下游模型分桶，不同模型 cache 不共享
- 自动清理：默认保留 1 周（604800000ms），清理周期 1 小时；启动执行一次 + setInterval unref
- 管理面：`/admin/api/sessions` REST + Sessions.vue + AdminLayout 菜单
- Open WebUI 需设置 `ENABLE_FORWARD_USER_INFO_HEADERS=true` 才会转发 chat_id header（Open WebUI 侧 env 默认 False）
- 项目规范：中文注释、camelCase 方法、vitest、tsc --noEmit 0 错误

## 关键设计

### sessions 表（server/src/session/db.ts，与建表 SQL 一致）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_key      TEXT PRIMARY KEY,   -- ${downstreamModel}::${raw}
  session_id       TEXT NOT NULL,      -- 原始会话键值（header 值或内容 hash hex）
  client           TEXT NOT NULL,      -- 'open-webui' | 'content-hash' | 'unknown'
  downstream_model TEXT NOT NULL,
  upstream_id      TEXT NOT NULL,
  upstream_model   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,   -- epoch ms
  updated_at       INTEGER NOT NULL    -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
```

### SessionStore 方法（better-sqlite3 同步 API，预编译语句）

`get` / `bind`（INSERT OR REPLACE 覆盖式写入）/ `touch`（刷新 updated_at，返回是否命中）/ `rebind` / `list`（updated_at 倒序，client 精确 + keyword 模糊匹配 session_id/upstream_id，返回 { rows, total }）/ `delete` / `clear` / `cleanup(maxAgeMs)` / `close`。WAL pragma 开启。清理调度不在本模块，由装配层负责。

### 会话键提取（server/src/session/key.ts）

`extractSessionKey(req, body)`：header 非空优先，其次 body.messages 长度 ≥ 1 时取前 2 条做 sha256，都不满足返回 undefined。content 字段缺失视为空串保持稳定，null/多模态数组/对象用 JSON.stringify 参与哈希。

### 路由层（server/src/router/load-balancer.ts + fallback.ts）

`RequestCtx` 含 `{ downstreamModel, sessionKey?, client? }`。`SessionAffinityLoadBalancer.pick`：

1. 无 sessionKey 委托内部 RoundRobin
2. 命中且记录上游仍在候选 → touch + 返回（保持粘附）
3. 未命中 / 记录上游已删除或禁用 → 轮询重选 + bind 新映射

`executeWithFallback(candidates, lb, ctx, callFn, onSuccess?)`：onSuccess 为第 5 个可选参数，仅当某候选调用成功（ok=true）时回调实际成功上游，供处理器做会话映射 rebind（回退后实际成功上游可能 ≠ 首选）。

### 配置（server/src/config/schema.ts）

```ts
routing: z.object({
  sessionAffinity: z.object({
    enabled: z.boolean().default(true),              // 总开关，缺省 true
    cleanupMaxAgeMs: z.number().int().min(0).default(604800000), // 1 周；0 表示永不过期
    cleanupIntervalMs: z.number().int().min(0).default(3600000), // 1 小时；0 关闭自动清理
  }).prefault({}),
}).optional()
```

### 管理 API（server/src/server/admin.ts）

- `GET /admin/api/sessions?client&keyword&offset&limit`：updated_at 倒序分页，返回 `{ rows, total }`
- `DELETE /admin/api/sessions/:sessionKey`：解绑，幂等，返回 `{ deleted: boolean }`
- `DELETE /admin/api/sessions`：清空，返回 `{ deleted: number }`
- `POST /admin/api/sessions/cleanup`：立即清理，保留期从配置 `routing.sessionAffinity.cleanupMaxAgeMs` 读取；0 时跳过返回 `{ deleted: 0 }`

自动清理在装配层（server/src/server/index.ts）：启动执行一次 + setInterval（interval 从配置读，0 关闭）。

### 接入与装配

openai.ts / ollama.ts 处理器内 `extractSessionKey(req, body)` 得 sessionKey/client 传入 ctx；成功分支（onSuccess）在 `ctx.sessionKey` 存在时 `sessionStore.rebind(sessionKey, candidate.upstreamId, candidate.model)`。index.ts 构造 SessionStore（`join(getDataDir(), 'llmproxy.db')`）+ SessionAffinityLoadBalancer（包一层 RoundRobin），并按 `enabled` 开关选择均衡器。

## 实现要点与计划的差异说明

以下为计划（.omo/plans/session-affinity-routing.md）与实际实现不一致之处，以代码为准：

- **T3 key.ts 返回形状**：计划写 `{ raw?: string; client?: string } | undefined`。实现时调整为：`SessionKeyResult { raw: string; client: 'open-webui' | 'content-hash' } | undefined`，raw 与 client 均必填，client 为字面量联合类型；'unknown' 不作为提取结果，仅作 DB bind 时的兜底值（bind 时缺省 'unknown'）。
- **T4 schema 缺省写法**：计划写 `sessionAffinity: z.object({...}).default({})`。实现时调整为 `.prefault({})`：zod v4 中 `.default()` 不会把默认值再过一遍 schema（内部字段默认值不生效），须用 `.prefault({})` 让空对象先进入 schema 解析以级联内部默认值；外层 `routing` 键为 `optional()` 而非 `.default({})`。配置键 `routing.sessionAffinity` 与计划一致。
- **T5 fallback onSuccess 签名**：计划"增加可选 onSuccess"已按预期实现，签名 `executeWithFallback(candidates, lb, ctx, callFn, onSuccess?)`。补充一点：onSuccess 只在候选调用成功（ok=true）时触发；处理器侧仅在 ctx.sessionKey 存在时执行 rebind（openai.ts/ollama.ts 内 `deps.sessionStore?.rebind(...)`）。
- **T5 bind 的 sessionId 来源**：计划未明确。实现时：bind 的 sessionId 由 sessionKey 反解得到（parseRawSessionKey 从第一个 `::` 分割，raw 本身可能含 `::`，取其后全部）。
- **T6 sessions API 响应字段**：计划未提。实现时：列表接口返回 `{ rows, total }`（total 为满足筛选条件的总数，不含分页）；删除/清空/清理均返回 `deleted` 字段，单删幂等。
- **T7 开关消费修复**：learnings 记录实施中修复的遗漏：`routing.sessionAffinity.enabled` 开关初始未被消费。实现时已修复：index.ts 按 `enabled !== false` 选择 SessionAffinityLoadBalancer 或纯 RoundRobinLoadBalancer，开关在启动时确定，不做热更新重选。
- **T2 建表细节**：计划 `INSERT ON CONFLICT REPLACE` 语义，实现为 `INSERT OR REPLACE`（等价，覆盖式写入且 created_at/updated_at 均刷新为 now）；`touch` 对不存在记录返回 false；`rebind` 对不存在记录静默忽略。
- **T8 前端**：Sessions.vue 表格/筛选（client、关键字）/分页/单删/清空/立即清理均已实现；实测页面每 5 秒自动刷新。

## 验证结果

来源：`.omo/notepads/session-affinity-routing/learnings.md`（2026-08-03 实施完成总结）

- 全部 9 项任务完成；最终回归：server 273 tests（排除环境受限的 watcher/integration）+ typecheck 0 + vue-tsc 0 + 浏览器实测 + curl 实测
- 端到端实测证据：真实服务已产生 content-hash 会话粘附记录（client=content-hash，粘附 10-qwen3.5-9b / qwen3.5-9b 不同上游）；带 X-OpenWebUI-Chat-Id header 两次请求粘同一上游（仅 1 条记录，updated_at 刷新）；/admin/api/sessions 列表/单删/清空/cleanup 全部可用
- Sessions.vue 页面实测：菜单/表格/筛选/分页正常，6 条真实会话记录，console 仅 favicon 404（原有无害）
- 验收标准全部满足：同前缀粘同一上游 ✓、无会话键走轮询 ✓、sessions API 全套 ✓、自动清理默认 1 周 ✓、全量测试通过 ✓

## 已知问题

来源：`.omo/notepads/session-affinity-routing/issues.md`

- 环境问题（与代码无关）：inotify 上限耗尽。`/proc/sys/fs/inotify/max_user_instances` = 128，当前已用 180（trae 编辑器、weather-mcp、nrs-mcp、playwright daemon 等系统进程占用），无 root 权限无法提升
- 影响：watcher.test.ts（4 例）与 integration.test.ts（1 例）报 `EMFILE: too many open files, watch '...'`（chokidar 创建 fs.watch 失败），与本次会话亲和改动无关（单独运行同样失败）
- 处置：全量测试排除 `src/config/watcher.test.ts`、`src/server/integration.test.ts`
- 建议：`sudo sysctl fs.inotify.max_user_instances=512`（或关闭部分常驻进程）后补跑

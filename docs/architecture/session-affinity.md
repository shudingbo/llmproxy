# 会话亲和路由架构

> 目标：同一会话的请求粘附同一上游，最大化 LLM prompt cache 利用率。
> 本文基于当前代码实际状态（`session/key.ts`、`session/db.ts`、`router/load-balancer.ts`、`router/fallback.ts`、`server/index.ts`、`server/admin.ts`）。

## 1. 总览

```mermaid
flowchart LR
    REQ[请求体 + headers] --> KEY[session/key.ts<br/>extractSessionKey]
    KEY -->|X-OpenWebUI-Chat-Id| K1[raw = header 值<br/>client = open-webui]
    KEY -->|内容前缀 hash| K2[raw = sha256 hex<br/>client = content-hash]
    KEY -->|都没有| K3[无会话键 → 轮询兜底]

    K1 --> JOIN[会话键 = `${downstreamModel}::${raw}`]
    K2 --> JOIN
    JOIN --> LB[SessionAffinityLoadBalancer.pick]
    LB -->|命中且在候选| TOUCH[touch 刷新 updated_at<br/>返回粘附上游]
    LB -->|未命中 / 上游已失效| PICK[轮询重选 + bind]
    PICK --> FB[executeWithFallback]
    FB -->|回退成功 ≠ 首选| REBIND[onSuccess → sessionStore.rebind]
    TOUCH --> FB
```

会话键格式约定：`${downstreamModel}::${raw}`（`downstreamModel` 为下游别名，`raw` 为 header 值或内容 hash 十六进制），由下游处理器（openai.ts / ollama.ts）拼接后放入 `RequestCtx.sessionKey`：

```ts
const session = extractSessionKey(req, body)
const ctx = {
  downstreamModel: model,
  sessionKey: session !== undefined ? `${model}::${session.raw}` : undefined,
  client: session?.client,
}
```

## 2. 会话键提取（`session/key.ts`）

`extractSessionKey(req, body): SessionKeyResult | undefined`，优先级从高到低，返回第一个命中：

1. **header `X-OpenWebUI-Chat-Id`**（大小写不敏感查找，重复 header 取第一个；值 trim 后非空才生效）→ `{ raw: header值, client: 'open-webui' }`
2. **内容前缀 hash**：`body.messages` 为数组且长度 ≥ 1 → 取**前 2 条消息**的 `[role, content]` 二元组做 sha256 → `{ raw: hashHex, client: 'content-hash' }`
3. 都不满足 → `undefined`（调用方走轮询兜底）

内容前缀 hash 的稳定规则（`hashContentPrefix`）：

```ts
const content =
  typeof msg.content === 'string'
    ? msg.content            // 字符串原样
    : msg.content === undefined
      ? ''                   // 字段缺失视为空串，保持稳定
      : JSON.stringify(msg.content) // null / 多模态数组 / 对象参与哈希
return createHash('sha256').update(JSON.stringify(prefix)).digest('hex')
```

只序列化 `[role, content]`，**不序列化 id / timestamp 等多余字段**，保证同前缀稳定。

## 3. 粘附存储（`session/db.ts`，SessionStore）

持久化到 `~/llmproxy/llmproxy.db` 的 `sessions` 表（WAL 模式，与日志表共存于同一文件）：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_key      TEXT PRIMARY KEY,   -- `${downstreamModel}::${raw}`
  session_id       TEXT NOT NULL,      -- 原始会话键值（header 值或 hash hex）
  client           TEXT NOT NULL,      -- 'open-webui' | 'content-hash' | 'unknown'
  downstream_model TEXT NOT NULL,
  upstream_id      TEXT NOT NULL,      -- 粘附的上游 id
  upstream_model   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,   -- epoch ms
  updated_at       INTEGER NOT NULL    -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
```

操作原语（better-sqlite3 同步 API + 预编译语句）：

| 方法 | SQL 语义 | 说明 |
| --- | --- | --- |
| `get(sessionKey)` | `SELECT * WHERE session_key = ?` | 不存在返回 undefined |
| `bind(sessionKey, info)` | `INSERT OR REPLACE` | 覆盖式写入，created_at / updated_at 均 now |
| `touch(sessionKey)` | `UPDATE ... SET updated_at = now` | 仅刷新更新时间；记录不存在返回 false |
| `rebind(sessionKey, upstreamId, upstreamModel)` | `UPDATE ... SET upstream_id, upstream_model, updated_at = now` | 改绑到实际成功上游；不存在则静默忽略 |
| `list({offset, limit, client?, keyword?})` | `ORDER BY updated_at DESC LIMIT ? OFFSET ?` + `COUNT(*)` | client 精确匹配，keyword 模糊匹配 session_id / upstream_id；total 不含分页 |
| `delete(sessionKey)` | `DELETE WHERE session_key = ?` | 返回是否删除成功 |
| `clear()` | `DELETE FROM sessions` | 清空整表，返回条数 |
| `cleanup(maxAgeMs)` | `DELETE WHERE updated_at < now - maxAgeMs` | 过期清理原语（调度由装配层负责） |

路由层只消费 `SessionStoreLike` 最小接口（`get / touch / bind / rebind`），不直接碰 SQLite。

## 4. 路由决策（`router/load-balancer.ts`）

`SessionAffinityLoadBalancer`（构造注入 SessionStore + 兜底均衡器，通常 RoundRobin）：

```ts
pick(candidates, ctx) {
  // 1. 无会话键 → 委托兜底均衡器（轮询），行为与无亲和时完全一致
  if (!ctx.sessionKey) return this.fallback.pick(candidates, ctx)
  // 2. 命中记录且记录的上游仍在候选 → touch 刷新并返回该候选（保持粘附）
  const record = this.store.get(sessionKey)
  if (record) {
    const bound = candidates.find((c) => c.upstreamId === record.upstream_id)
    if (bound) { this.store.touch(sessionKey); return bound }
  }
  // 3. 未命中 / 记录上游已被删除或禁用 → 兜底均衡器重选并 bind 新映射（覆盖旧映射）
  const picked = this.fallback.pick(candidates, ctx)
  this.store.bind(sessionKey, { sessionId: parseRawSessionKey(sessionKey), client: ctx.client ?? 'unknown', downstreamModel: ctx.downstreamModel, upstreamId: picked.upstreamId, upstreamModel: picked.model })
  return picked
}
```

要点：

- `parseRawSessionKey` 从第一个 `::` 之后取全部（raw 本身可能含 `::`）。
- 负载均衡只决定**起点**；同请求内的回退固定按 wrap 顺序尝试，不再问均衡器（游标只随新请求推进）。

### 4.1 回退成功后的改绑

回退成功时实际成功上游可能 ≠ 首选。`executeWithFallback` 的 `onSuccess` 钩子把实际成功候选回传给调用方，下游处理器（openai.ts / ollama.ts）据此改绑会话粘附：

```ts
onSuccess: (candidate) => {
  if (ctx.sessionKey !== undefined) {
    deps.sessionStore?.rebind(ctx.sessionKey, candidate.upstreamId, candidate.model)
  }
}
```

`sessionStore` 为可选注入，未注入则跳过改绑。

## 5. 配置（`config/schema.ts`）

```ts
routing: {
  sessionAffinity: {
    enabled:           boolean 默认 true      // 总开关；显式 false 时装配层退回纯轮询均衡器
    cleanupMaxAgeMs:   number  默认 604800000 // 会话保留期（1 周）；0 表示永不过期
    cleanupIntervalMs: number  默认 3600000   // 清理周期（1 小时）；0 关闭自动调度
  }
}
```

- **开关在启动时确定**（`server/index.ts`：`store.get().routing?.sessionAffinity?.enabled !== false`），不做热更新重选；整个 `routing` 节可缺省。
- 自动清理：启动执行一次 + `setInterval(cleanupIntervalMs).unref()`，每次清理成功条数 > 0 时记 `session-cleanup` 日志。

## 6. 管理面

### 6.1 REST 端点（`server/admin.ts`）

| 端点 | 说明 |
| --- | --- |
| `GET /admin/api/sessions` | 分页列表：updated_at 倒序；`client` 精确匹配、`keyword` 模糊匹配 session_id / upstream_id；offset 默认 0，limit 默认 100 上限 500；返回 `{ rows, total }` |
| `DELETE /admin/api/sessions/:sessionKey` | 删除单条（解绑），幂等，不存在也返回 200 `{ deleted: false }` |
| `DELETE /admin/api/sessions` | 清空整表，返回删除条数 |
| `POST /admin/api/sessions/cleanup` | 立即手动清理过期会话：保留期从 `routing.sessionAffinity.cleanupMaxAgeMs` 读取（缺省 1 周）；为 0 时跳过（返回 `{ deleted: 0 }`） |

参数校验失败返回 400 `{ error: 'invalid_query', issues }`；SQLite 异常返回 500 并记 warn 日志。

### 6.2 前端 Sessions 页（`web/src/views/Sessions.vue`）

展示粘附列表（client / 下游模型 / 粘附上游 / 更新时间），支持按 client 筛选、关键字搜索、分页、单条删除 / 全部清空 / 手动清理。

## 7. 行为说明与边界

- **不同会话相同前缀会粘附同一上游**：内容前缀 hash 只取前 2 条消息，前缀相同的会话（如长对话的多个请求、同一主题的多轮）会落到同一上游——这无害且有利于 prompt cache 命中；只有前缀真正不同才会轮询到不同上游。
- **探测不到会话键的客户端走轮询**：如 opencode 等不带 `X-OpenWebUI-Chat-Id` 且请求体无 `messages` 数组（或为空）的请求 → `extractSessionKey` 返回 undefined → `SessionAffinityLoadBalancer` 委托轮询均衡器，行为与关闭亲和完全一致。
- **上游被删除 / 禁用后**：粘附记录中的 `upstream_id` 不再出现在候选列表 → 重选并 bind 覆盖旧映射；禁用上游的候选在 `Router.resolve` 阶段即被过滤。
- **手动解绑**（删除单条 / 清空）后，下一次请求重新选择上游。

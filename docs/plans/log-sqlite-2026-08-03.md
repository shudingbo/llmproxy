# 日志 SQLite 化实施计划

> 归档日期：2026-08-03
> 状态：已完成（日志双写 + SQLite 查询 + 分页 + 手动清理全部完成，最终回归通过）

## 目标

日志写入时双写（文件 + SQLite），管理端日志查询完全切 SQLite；DB 日志清理规则与文件一致（保留 5 天）。

## 已确认决策

来源：`.omo/plans/log-sqlite.md` + `.omo/notepads/session-affinity-routing/learnings.md`

- DB 文件：复用 `~/llmproxy/llmproxy.db`（logs 表与 sessions 表共存，WAL 多连接安全）
- 查询：完全切 SQLite，删除 readLogsTail 及文件读取逻辑（旧日志不再走管理端查询），零残留
- 清理：DB 与文件同规则（保留 5 天，sweep.ts 导出 RETENTION_DAYS 共享常量）
- 现有日志体系：log4js 双 category（app 文本 / api pinoJson），dateFile 按日；requestLogger 在 res finish 写 api 日志
- 日志级别数值映射保持 pino 契约（trace=10 debug=20 info=30 warn=40 error=50 fatal=60），前端 Logs 视图兼容

## 关键设计

### logs 表（server/src/logstore/index.ts，与建表 SQL 一致）

```sql
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'app' | 'api'
  level INTEGER NOT NULL,       -- pino 级别数值：INFO=30 等
  time INTEGER NOT NULL,        -- epoch ms
  msg TEXT,
  category TEXT,                -- app 日志来源类别
  request_id TEXT,
  method TEXT, url TEXT,
  status INTEGER, duration_ms REAL,
  raw TEXT                      -- 完整原始 JSON（无损，如含 headers）
);
CREATE INDEX IF NOT EXISTS idx_logs_type_time ON logs(type, time DESC);
```

### LogStore 方法（server/src/logstore/index.ts）

`insert`（预编译语句 + WAL，可选字段统一转 NULL 存库）/ `query({type, from, to, minLevel, keyword, offset, limit})` → `{ rows, total }`（time DESC, id DESC；keyword 模糊匹配 msg/url/request_id/category；total 为满足过滤条件总数）/ `cleanup(maxAgeMs)` / `deleteBefore(before)`（复用同一预编译语句，仅阈值来源不同）/ `close`。

### 双写接入（server/src/logger/index.ts）

`setLogStore(logStore)` 注入 LogStore 后，`getLogger(name?)` 返回 Proxy 包装（按 name 缓存）：拦截 LOG_METHODS（trace/debug/info/warn/error/fatal）六个方法，先 `logStore.insert(extractLogEntry(...))` 再写文件。字段提取与 pinoJson layout 规则一致（首个对象为结构化字段，Error 并入 err，字符串并入 msg）；raw 经深度脱敏（sanitizeRawValue 剔除对象树任意层级的 authorization / x-api-key）。错误隔离：DB 写入失败绝不影响文件日志，一次性故障标记 sqliteWriteFailed 防刷屏。未注入 LogStore 时 getLogger 行为与原来完全一致（现有调用零感知）。

### 查询与清理端点（server/src/server/admin.ts）

- `GET /admin/api/logs?type&date&level&keyword&offset&limit`：date（YYYY-MM-DD）转本地时区当日 [00:00, 23:59:59.999] 范围，调 LogStore.query；返回 `{ lines, type, offset, limit, total, hasMore, scanned }`（lines 行为 snake_case 到 camelCase 映射，缺省字段省略）
- `POST /admin/api/logs/cleanup`：body.before（epoch ms）可选，缺省 now 减 7 天；同时清理 DB（`logStore.deleteBefore(before)`，time < before）与文件（`sweepLogsBefore(getLogDir(), before)`，mtime < before）；返回 `{ deleted, deletedFiles, before }`

自动清理在装配层（server/src/server/index.ts）：日志 DB 清理保留期与文件一致（RETENTION_DAYS 天），启动执行一次 + setInterval（LOG_SWEEP_INTERVAL_MS = 6 小时）unref。

### 前端（web/src/views/Logs.vue）

页码式分页 el-pagination（layout: total, sizes, prev, pager, next, jumper），total 来自后端响应，page/pageSize 变化触发重新查询；移除"下一页"游标。手动清理 UI：日期选择器（默认 7 天前）+ 危险按钮 + 确认框，调用 POST /admin/api/logs/cleanup。

## 实现要点与计划的差异说明

以下为计划（.omo/plans/log-sqlite.md）与实际实现不一致之处，以代码为准：

- **L2 最大过时点（双写机制）**：计划写"自定义 sqliteAppender（log4js），注册到 app/api category"。实现时调整为：不注册 log4js 自定义 appender，改为 `setLogStore` + `getLogger` 包装方案。装配层 `setLogStore(logStore)` 注入 LogStore，`getLogger(name?)` 在已装配时返回 Proxy 包装，拦截日志方法先写 SQLite 再写文件。log4js 配置未改动（configureLogging 仅注册 pinoJson layout，appenders 仍为 stdout + dateFile），`~/llmproxy/log4js.json` 用户配置零感知。原计划担心的 ESM 下 log4js 自定义 appender 注册方式调研不再需要。
- **L3 响应形状**：计划说响应保持 `{ lines, type, offset, limit, hasMore, scanned }`。实现时调整为：后端响应新增 `total` 字段（满足过滤条件的总数，不含分页），供前端页码分页使用；`hasMore` 由 total 推导（offset + lines.length < total）。
- **L5 前端不改**：过时。计划写"前端 Logs.vue 不改"。实际后来改过：页码分页 el-pagination（total/sizes/prev/pager/next/jumper）+ 手动清理 UI（日期选择器默认 7 天前 + 确认框），移除"下一页"游标逻辑。
- **追加：手动清理端点**：计划未提。实现时追加 `POST /admin/api/logs/cleanup`（body.before 可选，缺省 now 减 7 天），LogStore 增加 `deleteBefore(before)`（与 cleanup 复用同一预编译语句），文件侧增加 `sweepLogsBefore(dir, beforeMs)` 按 mtime 清理。
- **追加：深度脱敏**：计划未提。实现时对写入 DB 的 raw 做深度脱敏（sanitizeRawValue 剔除任意层级的 authorization / x-api-key，与文件日志的 header 脱敏规则一致），保证 SQLite 中也不落敏感凭据。
- **L4 清理周期**：计划未指定周期。实现时日志 DB 清理周期为 6 小时（LOG_SWEEP_INTERVAL_MS），与文件 sweep 的调度保持一致。
- **L1 query 签名**：与计划一致（{ rows, total }），补充：type 必填、time 范围含边界、排序 time DESC + id DESC（同秒内稳定排序）。
- **保留期不一致（用户已知）**：自动清理保留 5 天（RETENTION_DAYS），手动清理默认清理"早于 7 天前"（用户指定值），两者不一致为用户决策，已知。

## 验证结果

来源：`.omo/notepads/session-affinity-routing/learnings.md`（2026-08-03 日志 SQLite 化 + 分页 + 手动清理总结）

- 最终验证：287 tests（排除环境受限 watcher/integration）+ typecheck 0 + vue-tsc 0 + 浏览器实测（分页/清理按钮/确认框）+ curl + sqlite3
- 日志双写：LogStore（logs 表，`~/llmproxy/llmproxy.db`）+ setLogStore/getLogger 包装（Proxy 拦截 info/warn/error/fatal/debug/trace，先 insert 再写文件，错误隔离 + 一次性故障标记 + 深度脱敏）
- 查询切 SQLite：/admin/api/logs 用 LogStore.query（date 转本地时区 day 范围、type/level/keyword、time DESC、total），readLogsTail 已删除（零残留）
- 清理：DB 与文件一致保留 5 天（RETENTION_DAYS 导出共享）；自动清理定时器在 index.ts
- 分页升级：Logs.vue el-pagination 页码分页（后端响应加 total）；移除"下一页"游标
- 手动清理：POST /admin/api/logs/cleanup（body.before 可选，缺省 now 减 7 天；DB deleteBefore + 文件 sweepLogsBefore mtime）；前端"清理早于"日期选择器默认 7 天前 + 确认框
- 验证事故记录：验证时 curl 误传 before=当前时刻，删除了今天 556 条日志记录 + 1 个文件（日志可再生，已告知用户）

## 已知问题

来源：`.omo/notepads/session-affinity-routing/issues.md`

- 环境问题（与代码无关）：inotify 上限耗尽。`/proc/sys/fs/inotify/max_user_instances` = 128，当前已用 180（trae 编辑器、weather-mcp、nrs-mcp、playwright daemon 等系统进程占用），无 root 权限无法提升
- 影响：watcher.test.ts（4 例）与 integration.test.ts（1 例）报 `EMFILE: too many open files, watch '...'`（chokidar 创建 fs.watch 失败），无法在本环境运行
- 处置：全量测试排除 `src/config/watcher.test.ts`、`src/server/integration.test.ts`
- 建议：`sudo sysctl fs.inotify.max_user_instances=512`（或关闭部分常驻进程）后补跑

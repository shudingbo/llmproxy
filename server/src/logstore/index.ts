// 日志的 SQLite 存储层：把日志条目持久化到 ~/llmproxy/llmproxy.db（与 sessions 表共存于同一 DB 文件）
// 职责：只做存储（insert/query/cleanup/close），不做格式化、不写文件、不碰 HTTP
// 背景：日志双写方案的一部分——log4js appender 双写（文件 + 本模块 insert），
// 管理端 /admin/api/logs 查询走 SQLite（本模块 query），清理与文件规则一致保留 5 天（本模块 cleanup）
// api 日志为高频写入：insert 使用预编译语句 + WAL，保证写入性能
// DB 文件路径由装配层传入，本模块不关心具体路径
import Database from 'better-sqlite3'

// 写入条目：camelCase 入参，内部映射为 snake_case 列名
export interface LogEntry {
  type: 'app' | 'api'
  level: number // pino 级别数值：INFO=30 等
  time: number // epoch ms
  msg?: string
  category?: string // app 日志来源类别
  requestId?: string // api 日志
  method?: string
  url?: string
  status?: number
  durationMs?: number
  raw?: string // 完整原始 JSON（无损，如含 headers）
}

// 查询返回行：snake_case 列名，与表结构一一对应（便于直接映射）
export interface LogRow {
  id: number
  type: string
  level: number
  time: number
  msg: string | null
  category: string | null
  request_id: string | null
  method: string | null
  url: string | null
  status: number | null
  duration_ms: number | null
  raw: string | null
}

// 查询条件：type 必填；from/to 为 time 范围（含边界）；keyword 模糊匹配 msg/url/request_id/category
export interface LogQueryOptions {
  type: 'app' | 'api'
  from: number // time 范围起点（含），epoch ms
  to: number // time 范围终点（含），epoch ms
  minLevel: number // level >= minLevel
  keyword?: string // 模糊匹配 msg/url/request_id/category（任意一个命中）
  offset: number
  limit: number
}

// 查询结果：rows 为本页记录（time DESC, id DESC），total 为满足过滤条件的总数（不含分页）
export interface LogQueryResult {
  rows: LogRow[]
  total: number
}

// 建表语句（契约固定）：type 与 time 建复合索引，支撑高频的 type + 时间范围查询
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  level INTEGER NOT NULL,
  time INTEGER NOT NULL,
  msg TEXT,
  category TEXT,
  request_id TEXT,
  method TEXT,
  url TEXT,
  status INTEGER,
  duration_ms REAL,
  raw TEXT
);`

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_logs_type_time ON logs(type, time DESC);`

// 列名清单：INSERT 与建表共用一份，避免两处手写字段列表不一致
const LOG_COLUMNS = [
  'type',
  'level',
  'time',
  'msg',
  'category',
  'request_id',
  'method',
  'url',
  'status',
  'duration_ms',
  'raw',
] as const

// 可选字段统一转 NULL 存库：LogEntry 中 undefined 表示缺省，入库即 NULL（与表列类型一致）
const n = <T,>(v: T | undefined): T | null => v ?? null

export class LogStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly insertStmt: Database.Statement<
    [string, number, number, string | null, string | null, string | null, string | null, string | null, number | null, number | null, string | null]
  >
  private readonly cleanupStmt: Database.Statement<[number]>

  /**
   * 打开（必要时创建）数据库文件：启用 WAL 日志模式，并建表、建索引。
   * WAL 支持多连接并发（同一 DB 文件已有 SessionStore 连接），读写互不阻塞。
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：journal 文件与 db 同目录，随 db 文件一起清理
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(CREATE_INDEX_SQL)

    this.insertStmt = this.db.prepare(
      `INSERT INTO logs (${LOG_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.cleanupStmt = this.db.prepare('DELETE FROM logs WHERE time < ?')
  }

  // 写入一条日志：可选字段（undefined）存 NULL；高频调用，走预编译语句
  insert(entry: LogEntry): void {
    this.insertStmt.run(
      entry.type,
      entry.level,
      entry.time,
      n(entry.msg),
      n(entry.category),
      n(entry.requestId),
      n(entry.method),
      n(entry.url),
      n(entry.status),
      n(entry.durationMs),
      n(entry.raw),
    )
  }

  // 分页查询：type 必填 + time 范围 + level 下限 + keyword 模糊匹配；
  // 最新在前（time DESC, id DESC）；total 为满足过滤条件的总数（不含分页）
  query(opts: LogQueryOptions): LogQueryResult {
    const { type, from, to, minLevel, keyword, offset, limit } = opts
    // 动态拼接 WHERE 条件（SQL 片段固定，仅组合方式随参数变化，无注入面）
    const conditions: string[] = ['type = ?', 'time BETWEEN ? AND ?', 'level >= ?']
    const params: Array<string | number> = [type, from, to, minLevel]
    if (keyword !== undefined && keyword !== '') {
      conditions.push('(msg LIKE ? OR url LIKE ? OR request_id LIKE ? OR category LIKE ?)')
      const like = `%${keyword}%`
      params.push(like, like, like, like)
    }
    const whereSql = ` WHERE ${conditions.join(' AND ')}`
    const rows = this.db
      .prepare(`SELECT * FROM logs${whereSql} ORDER BY time DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as LogRow[]
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM logs${whereSql}`)
      .get(...params) as { total: number }
    return { rows, total: countRow.total }
  }

  // 过期清理：删除 time < now - maxAgeMs 的记录；返回删除条数
  cleanup(maxAgeMs: number): number {
    return this.cleanupStmt.run(Date.now() - maxAgeMs).changes
  }

  // 手动清理：按时间戳删除该时刻之前的日志（time < before）；返回删除条数
  // 与 cleanup 复用同一预编译语句（SQL 相同，仅阈值来源不同：自动清理按保留期、手动清理按用户选择的时间范围）
  deleteBefore(before: number): number {
    return this.cleanupStmt.run(before).changes
  }

  // 关闭连接（WAL 模式下关闭后数据仍持久化在 db 文件中）
  close(): void {
    this.db.close()
  }
}

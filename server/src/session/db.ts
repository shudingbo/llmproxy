// 会话亲和路由的 SQLite 存储层：把"会话键 → 粘附上游"持久化到 ~/llmproxy/llmproxy.db
// 职责：只做存储（get/bind/touch/rebind/list/delete/clear/cleanup），不做路由决策、不碰 HTTP
// 会话键格式：${downstreamModel}::${raw}（raw 为 header 值或内容前缀 hash，见 session/key.ts）
// 清理调度/定时器不属于本模块（由调用方负责）；本模块仅提供按过期时间删除的 cleanup 原语
import Database from 'better-sqlite3'
import { SessionClient } from './key.js'

// 一条会话粘附记录（与 sessions 表字段一一对应，字段名与表列保持一致便于直接映射）
export interface SessionRow {
  session_key: string // 主键：`${downstreamModel}::${raw}`
  session_id: string // 原始会话键值（header 值或内容 hash hex）
  client: string // 'open-webui' | 'x-session-id' | 'ywnrs' | 'github' | 'opencode' | 'content-hash' | 'unknown'
  downstream_model: string
  upstream_id: string // 粘附的上游 id
  upstream_model: string // 上游侧模型名
  created_at: number // epoch ms
  updated_at: number // epoch ms
  // ===== 用量统计（逐请求累加，见 recordUsage；来源见 session/usage.ts）=====
  request_count: number // 成功请求数（无 usage 的请求也计数）
  prompt_tokens: number // 累计输入 token（上游未返回 usage 的请求贡献 0）
  completion_tokens: number // 累计输出 token
  total_tokens: number // 累计总 token
  first_token_ms: number // 累计首 token 时延（仅流式且收到内容 delta 的请求参与累加）
  first_token_count: number // 首 token 时延测量次数（前端据此算平均 TTFT）
  generation_ms: number // 累计输出生成时长（流式 = 流结束 − 首 token；非流式 = 全程耗时）
}

// 一次成功请求的用量累加入参（捕获口径见 session/usage.ts：
// usage 取上游响应 / 流末尾 usage 块，首 token 时延取流式首个内容 delta）
export interface SessionUsageRecord {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  // 首 token 时延（ms）；0 表示本次未测量（非流式，或流式未收到任何内容 delta）
  firstTokenMs: number
  // 0/1：firstTokenMs 是否被测量（累加到 first_token_count，供前端计算平均值）
  firstTokenMeasured: number
  // 输出生成时长（ms）：流式 = 流结束 − 首 token（无首 token 时取全程）；非流式 = 全程
  generationMs: number
}

// list 分页结果：rows 为本页记录，total 为满足筛选条件的总数（不含分页）
export interface SessionListResult {
  rows: SessionRow[]
  total: number
}

// 绑定入参：调用方从会话键提取结果（session/key.ts）+ 路由决策得出粘附目标
export interface SessionBindInfo {
  sessionId: string
  client: string
  downstreamModel: string
  upstreamId: string
  upstreamModel: string
}

// 建表语句（契约固定）：session_key 主键；updated_at 建索引，供倒序排序与过期清理使用
// 后 7 列为用量统计（逐请求累加，见 recordUsage）
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  session_key      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  client           TEXT NOT NULL,
  downstream_model TEXT NOT NULL,
  upstream_id      TEXT NOT NULL,
  upstream_model   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  first_token_ms    INTEGER NOT NULL DEFAULT 0,
  first_token_count INTEGER NOT NULL DEFAULT 0,
  generation_ms     INTEGER NOT NULL DEFAULT 0
);`

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);`

// 用量统计列迁移清单：旧版本构建已建的 sessions 表缺这些列 → 打开时逐列补齐（既有行取默认 0），
// 与 session_messages.reasoning 的迁移同口径
const USAGE_COLUMN_MIGRATIONS = [
  { name: 'request_count', ddl: 'request_count INTEGER NOT NULL DEFAULT 0' },
  { name: 'prompt_tokens', ddl: 'prompt_tokens INTEGER NOT NULL DEFAULT 0' },
  { name: 'completion_tokens', ddl: 'completion_tokens INTEGER NOT NULL DEFAULT 0' },
  { name: 'total_tokens', ddl: 'total_tokens INTEGER NOT NULL DEFAULT 0' },
  { name: 'first_token_ms', ddl: 'first_token_ms INTEGER NOT NULL DEFAULT 0' },
  { name: 'first_token_count', ddl: 'first_token_count INTEGER NOT NULL DEFAULT 0' },
  { name: 'generation_ms', ddl: 'generation_ms INTEGER NOT NULL DEFAULT 0' },
] as const

// 列名清单：INSERT 与建表共用一份，避免两处手写字段列表不一致
const SESSION_COLUMNS = [
  'session_key',
  'session_id',
  'client',
  'downstream_model',
  'upstream_id',
  'upstream_model',
  'created_at',
  'updated_at',
  'request_count',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'first_token_ms',
  'first_token_count',
  'generation_ms',
] as const

export class SessionStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly getStmt: Database.Statement<[string], SessionRow>
  private readonly upsertStmt: Database.Statement<
    [string, string, string, string, string, string, number, number, number, number, number, number, number, number, number]
  >
  private readonly touchStmt: Database.Statement<[number, string]>
  private readonly rebindStmt: Database.Statement<[string, string, number, string]>
  private readonly deleteStmt: Database.Statement<[string]>
  private readonly clearStmt: Database.Statement<[]>
  private readonly cleanupStmt: Database.Statement<[number]>
  private readonly usageStmt: Database.Statement<[number, number, number, number, number, number, string]>

  /**
   * 打开（必要时创建）数据库文件：启用 WAL 日志模式，并建表、建索引。
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：读写并发更友好；journal 文件与 db 同目录，随 db 文件一起清理
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
    // 旧库迁移：旧版本构建已建的 sessions 表缺用量统计列 → 逐列补齐（既有行取默认 0）
    const existingColumns = this.db
      .prepare("PRAGMA table_info('sessions')")
      .all() as Array<{ name: string }>
    for (const col of USAGE_COLUMN_MIGRATIONS) {
      if (!existingColumns.some((c) => c.name === col.name)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col.ddl}`)
      }
    }
    this.db.exec(CREATE_INDEX_SQL)

    this.getStmt = this.db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_key = ?')
    this.upsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.touchStmt = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?')
    this.rebindStmt = this.db.prepare(
      'UPDATE sessions SET upstream_id = ?, upstream_model = ?, updated_at = ? WHERE session_key = ?',
    )
    this.deleteStmt = this.db.prepare('DELETE FROM sessions WHERE session_key = ?')
    this.clearStmt = this.db.prepare('DELETE FROM sessions')
    this.cleanupStmt = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?')
    this.usageStmt = this.db.prepare(
      `UPDATE sessions SET
         request_count = request_count + 1,
         prompt_tokens = prompt_tokens + ?,
         completion_tokens = completion_tokens + ?,
         total_tokens = total_tokens + ?,
         first_token_ms = first_token_ms + ?,
         first_token_count = first_token_count + ?,
         generation_ms = generation_ms + ?
       WHERE session_key = ?`,
    )
  }

  // 按会话键读取记录；不存在返回 undefined
  get(sessionKey: string): SessionRow | undefined {
    return this.getStmt.get(sessionKey)
  }

  // 绑定（覆盖式写入）：不存在则插入、存在则整体替换，created_at/updated_at 均为 now；
  // 用量统计列随整体替换重置为 0（重新绑定视为新的粘附生命周期，不继承旧统计）
  bind(sessionKey: string, info: SessionBindInfo): void {
    const now = Date.now()
    this.upsertStmt.run(
      sessionKey,
      info.sessionId,
      info.client,
      info.downstreamModel,
      info.upstreamId,
      info.upstreamModel,
      now,
      now,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    )
  }

  // 触摸：仅刷新 updated_at=now；记录不存在返回 false
  touch(sessionKey: string): boolean {
    return this.touchStmt.run(Date.now(), sessionKey).changes > 0
  }

  // 改绑上游：更新 upstream_id/upstream_model 并刷新 updated_at；记录不存在则静默忽略
  rebind(sessionKey: string, upstreamId: string, upstreamModel: string): void {
    this.rebindStmt.run(upstreamId, upstreamModel, Date.now(), sessionKey)
  }

  // 用量累加：一次成功请求的统计并入会话行——request_count 恒 +1（无 usage 的请求也计数），
  // token 数 / 首 token 时延 / 生成时长按传入值累加（未测量项传 0）。
  // UPDATE-only：行不存在（已解绑 / 过期清理）时返回 false 且不复活记录
  recordUsage(sessionKey: string, record: SessionUsageRecord): boolean {
    return (
      this.usageStmt.run(
        record.promptTokens,
        record.completionTokens,
        record.totalTokens,
        record.firstTokenMs,
        record.firstTokenMeasured,
        record.generationMs,
        sessionKey,
      ).changes > 0
    )
  }

  // 分页列表：updated_at 倒序；client 精确匹配，keyword 模糊匹配 session_id 或 upstream_id；
  // total 为满足筛选条件的总数（不含分页）
  list(opts: { offset: number; limit: number; client?: string; keyword?: string }): SessionListResult {
    const { offset, limit, client, keyword } = opts
    // 动态拼接 WHERE 条件（SQL 片段固定，仅组合方式随参数变化，无注入面）
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (client !== undefined && client !== '') {
      conditions.push('client = ?')
      params.push(client)
    }
    if (keyword !== undefined && keyword !== '') {
      conditions.push('(session_id LIKE ? OR upstream_id LIKE ?)')
      const like = `%${keyword}%`
      params.push(like, like)
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM sessions${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SessionRow[]
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM sessions${whereSql}`)
      .get(...params) as { total: number }
    return { rows, total: countRow.total }
  }

  // 列出全部 client 去重值（按字母序）；空库返回 []
  listClients(): SessionClient[] {
    const rows = this.db
      .prepare('SELECT DISTINCT client FROM sessions ORDER BY client ASC')
      .all() as Array<{ client: string }>
    return rows.map((r) => r.client as SessionClient)
  }

  // 删除单条记录；返回是否删除成功
  delete(sessionKey: string): boolean {
    return this.deleteStmt.run(sessionKey).changes > 0
  }

  // 清空整表；返回删除条数
  clear(): number {
    return this.clearStmt.run().changes
  }

  // 过期清理：删除 updated_at < now - maxAgeMs 的记录；返回删除条数
  cleanup(maxAgeMs: number): number {
    return this.cleanupStmt.run(Date.now() - maxAgeMs).changes
  }

  // 关闭连接（WAL 模式下关闭后数据仍持久化在 db 文件中）
  close(): void {
    this.db.close()
  }
}

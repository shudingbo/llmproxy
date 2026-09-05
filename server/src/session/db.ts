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
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  session_key      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  client           TEXT NOT NULL,
  downstream_model TEXT NOT NULL,
  upstream_id      TEXT NOT NULL,
  upstream_model   TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);`

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);`

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
] as const

export class SessionStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly getStmt: Database.Statement<[string], SessionRow>
  private readonly upsertStmt: Database.Statement<
    [string, string, string, string, string, string, number, number]
  >
  private readonly touchStmt: Database.Statement<[number, string]>
  private readonly rebindStmt: Database.Statement<[string, string, number, string]>
  private readonly deleteStmt: Database.Statement<[string]>
  private readonly clearStmt: Database.Statement<[]>
  private readonly cleanupStmt: Database.Statement<[number]>

  /**
   * 打开（必要时创建）数据库文件：启用 WAL 日志模式，并建表、建索引。
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：读写并发更友好；journal 文件与 db 同目录，随 db 文件一起清理
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(CREATE_INDEX_SQL)

    this.getStmt = this.db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE session_key = ?')
    this.upsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.touchStmt = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?')
    this.rebindStmt = this.db.prepare(
      'UPDATE sessions SET upstream_id = ?, upstream_model = ?, updated_at = ? WHERE session_key = ?',
    )
    this.deleteStmt = this.db.prepare('DELETE FROM sessions WHERE session_key = ?')
    this.clearStmt = this.db.prepare('DELETE FROM sessions')
    this.cleanupStmt = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?')
  }

  // 按会话键读取记录；不存在返回 undefined
  get(sessionKey: string): SessionRow | undefined {
    return this.getStmt.get(sessionKey)
  }

  // 绑定（覆盖式写入）：不存在则插入、存在则整体替换，created_at/updated_at 均为 now
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

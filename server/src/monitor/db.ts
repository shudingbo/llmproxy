// 会话消息监控 SQLite 存储层：把"会话与 LLM 交互的消息"持久化到 ~/llmproxy/llmproxy.db
// 职责：只做存储（去重写入 / 普通写入 / 列表 / 级联删除 / 保留期清理），不做 SSE 解析、不做推送
// （解析与推送是 monitor/index.ts 门面与 stream-recorder.ts 的职责）
//
// 写入频率设计（关键性能点）：
//   - 请求侧消息按 (session_key, content_hash) 去重写入：多轮对话每轮重发的历史只落库一次
//   - 响应侧 assistant 消息在流结束 / 中断后整条写一次
//   - SSE delta 数据绝不逐 token 入库，只在内存累积、完成后落库一条
// 因此写库频率 ≈ 每请求一次（新消息数 + 一条 assistant），与 token 数无关
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

// 一条会话消息行（字段名与表列一致，便于直接映射）
export interface SessionMessageRow {
  id: number
  session_key: string
  role: string
  content: string
  content_hash: string
  created_at: number
}

// 建表语句：id 自增主键即时间序（插入序）；created_at 建索引供保留期清理
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS session_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key  TEXT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);`

// (session_key, id) 联合索引：按会话取历史（倒序 / 升序）走该索引
const CREATE_INDEX_KEY_SQL =
  'CREATE INDEX IF NOT EXISTS idx_session_messages_key ON session_messages(session_key, id);'
// (session_key, content_hash) 联合索引：请求侧去重判定的唯一热点查询
const CREATE_INDEX_DEDUP_SQL =
  'CREATE INDEX IF NOT EXISTS idx_session_messages_dedup ON session_messages(session_key, content_hash);'
const CREATE_INDEX_TIME_SQL =
  'CREATE INDEX IF NOT EXISTS idx_session_messages_time ON session_messages(created_at);'

export class SessionMessageStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly insertDedupStmt: Database.Statement<[string, string, string, string, number, string, string]>
  private readonly insertStmt: Database.Statement<[string, string, string, string, number]>
  private readonly listAscStmt: Database.Statement<[string], SessionMessageRow>
  private readonly listDescStmt: Database.Statement<[string, number], SessionMessageRow>
  private readonly countStmt: Database.Statement<[string], { total: number }>
  private readonly deleteBySessionStmt: Database.Statement<[string]>
  // 孤儿清理语句惰性 prepare：prepare 阶段就会校验子查询引用的 sessions 表存在性，
  // 独立测试库（无 sessions 表）在构造期 prepare 会抛 no such table
  private deleteOrphanedStmt: Database.Statement<[]> | null = null
  private readonly deleteExpiredStmt: Database.Statement<[number]>
  private readonly deleteAllStmt: Database.Statement<[]>
  private readonly hasSessionsStmt: Database.Statement<[]>
  private readonly selectByIdStmt: Database.Statement<[number], SessionMessageRow>

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：与 SessionStore / LogStore 等其它连接共用同一 db 文件时读写互不阻塞
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(CREATE_INDEX_KEY_SQL)
    this.db.exec(CREATE_INDEX_DEDUP_SQL)
    this.db.exec(CREATE_INDEX_TIME_SQL)

    // 去重写入：仅当 (session_key, content_hash) 不存在时插入；
    // INSERT ... SELECT 单语句完成"判定 + 插入"，避免读-写竞态（单进程同步 API 下本就无并发写）
    this.insertDedupStmt = this.db.prepare(
      `INSERT INTO session_messages (session_key, role, content, content_hash, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM session_messages WHERE session_key = ? AND content_hash = ?
       )`,
    )
    this.insertStmt = this.db.prepare(
      'INSERT INTO session_messages (session_key, role, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    this.listAscStmt = this.db.prepare(
      'SELECT * FROM session_messages WHERE session_key = ? ORDER BY id ASC',
    )
    this.listDescStmt = this.db.prepare(
      'SELECT * FROM session_messages WHERE session_key = ? ORDER BY id DESC LIMIT ?',
    )
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM session_messages WHERE session_key = ?')
    this.deleteBySessionStmt = this.db.prepare('DELETE FROM session_messages WHERE session_key = ?')
    this.deleteExpiredStmt = this.db.prepare('DELETE FROM session_messages WHERE created_at < ?')
    this.deleteAllStmt = this.db.prepare('DELETE FROM session_messages')
    this.hasSessionsStmt = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    this.selectByIdStmt = this.db.prepare('SELECT * FROM session_messages WHERE id = ?')
  }

  // 去重写入：同会话内同 (role, content) 已存在 → 返回 null（不写不重复）；否则插入并返回新行
  insertDedup(sessionKey: string, role: string, content: string): SessionMessageRow | null {
    const hash = hashMessage(role, content)
    const now = Date.now()
    const result = this.insertDedupStmt.run(sessionKey, role, content, hash, now, sessionKey, hash)
    if (result.changes === 0) {
      return null
    }
    // lastInsertRowid 类型为 number | bigint（better-sqlite3 大数保护），统一收敛为 number
    return this.selectByIdStmt.get(Number(result.lastInsertRowid)) ?? null
  }

  // 普通写入（响应侧 assistant 消息用：相同回答也要留痕，不去重）
  insert(sessionKey: string, role: string, content: string): SessionMessageRow {
    const hash = hashMessage(role, content)
    const now = Date.now()
    const result = this.insertStmt.run(sessionKey, role, content, hash, now)
    // 理论不可达（刚插入即查）；兜底抛错让调用方走隔离路径
    const row = this.selectByIdStmt.get(Number(result.lastInsertRowid))
    if (row === undefined) {
      throw new Error('session_messages insert 后回读失败')
    }
    return row
  }

  // 按会话取历史：id 升序（旧 → 新）；limit 为"最新 N 条"（0 / undefined 表示全部）
  list(sessionKey: string, limit?: number): SessionMessageRow[] {
    if (limit !== undefined && limit > 0) {
      return this.listDescStmt.all(sessionKey, limit).reverse()
    }
    return this.listAscStmt.all(sessionKey)
  }

  count(sessionKey: string): number {
    return this.countStmt.get(sessionKey)?.total ?? 0
  }

  // 级联删除：会话解绑 / 清空时调用；不存在返回 0
  deleteBySession(sessionKey: string): number {
    return this.deleteBySessionStmt.run(sessionKey).changes
  }

  // 孤儿清理：删除 sessions 表中已不存在的会话键的消息（过期清理 / 手动清理后的兜底）；
  // sessions 表缺失（独立测试库）时返回 0，不抛错
  deleteOrphaned(): number {
    if (this.hasSessionsStmt.get() === undefined) {
      return 0
    }
    if (this.deleteOrphanedStmt === null) {
      // 首次调用时 prepare（此时已确认 sessions 表存在）
      this.deleteOrphanedStmt = this.db.prepare(
        'DELETE FROM session_messages WHERE session_key NOT IN (SELECT session_key FROM sessions)',
      )
    }
    return this.deleteOrphanedStmt.run().changes
  }

  // 保留期清理：删除 created_at < now - maxAgeMs 的记录；返回删除条数
  deleteExpired(maxAgeMs: number): number {
    return this.deleteExpiredStmt.run(Date.now() - maxAgeMs).changes
  }

  // 全量清空：会话"清空全部"时级联调用；返回删除条数
  deleteAll(): number {
    return this.deleteAllStmt.run().changes
  }

  close(): void {
    this.db.close()
  }
}

// 内容指纹：sha256(role + \x00 + content)。role 参与哈希，防止"同文本不同角色"互相去重
// （如 user 问"你好"与 assistant 答"你好"是两条消息）
export function hashMessage(role: string, content: string): string {
  return createHash('sha256').update(`${role}\u0000${content}`).digest('hex')
}

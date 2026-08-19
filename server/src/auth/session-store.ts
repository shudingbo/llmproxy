// 管理员会话存储层：把"已登录管理员会话"持久化到 ~/llmproxy/llmproxy.db
// 职责：只做存储（create/get/touch/delete/cleanup），不做鉴权决策（由 admin-auth 中间件负责）
// 安全要点：
//   - session_id 为 32 字节 CSPRNG hex（64 字符），不可猜测
//   - 会话为滑动过期：每次有效访问 touch 刷新 expires_at
//   - 与 ApiKeyStore / SessionStore / LogStore 共用同一 DB 文件，WAL 多连接安全
import Database from 'better-sqlite3'

// 一条管理员会话记录（与 admin_sessions 表字段一一对应，字段名与表列保持一致便于直接映射）
export interface AdminSessionRow {
  session_id: string // 主键（64 字符 hex）
  username: string // 登录的管理员用户名
  created_at: number // epoch ms
  last_seen_at: number // epoch ms（滑动续期时间）
  expires_at: number // epoch ms；now >= expires_at 即过期
}

// 建表语句（契约固定）：session_id 主键；username 建索引（按用户名清理 / 统计）
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id   TEXT    PRIMARY KEY,
  username     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);`

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_admin_sessions_username ON admin_sessions(username);`

const CREATE_INDEX_EXPIRES_SQL = `CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);`

export class AdminSessionStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly insertStmt: Database.Statement<
    [string, string, number, number, number]
  >
  private readonly getBySessionIdStmt: Database.Statement<[string], AdminSessionRow>
  private readonly deleteStmt: Database.Statement<[string]>
  private readonly touchStmt: Database.Statement<[number, number, string]>

  /**
   * 打开（必要时创建）数据库文件：启用 WAL 日志模式，建表、建索引，并处理旧 schema 迁移。
   * 期望与 ApiKeyStore / SessionStore / LogStore 共用 ~/llmproxy/llmproxy.db，WAL 多连接安全
   *
   * 迁移策略（兼容线上旧版本 schema：PK 为 id、字段名为 last_used_at、多 ip 列）：
   *   1. CREATE TABLE IF NOT EXISTS —— 全新安装直接按新 schema 建表；已存在的旧表原样保留
   *   2. PRAGMA table_info 检测列；若缺 last_seen_at（旧表）→ 走迁移分支
   *   3. 迁移分支（事务内）：RENAME 旧表 → DROP 旧索引（释放名字）→ 建新表 + 索引
   *      → 拷贝数据（last_used_at → last_seen_at，id/ip 丢弃）→ DROP 旧表；失败 ROLLBACK 抛错
   *   4. 已是新 schema（全新 / 已迁移）→ 仅确保索引存在（幂等）
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：与其它表并发读写更友好
    this.db.pragma('journal_mode = WAL')
    // 1. 确保表存在（全新安装按新 schema 建表；旧 schema 表原样保留，交给下面检测）
    this.db.exec(CREATE_TABLE_SQL)
    // 2. 检测是否为旧 schema（缺 last_seen_at 列即视为旧表）
    const columnNames = (this.db.prepare('PRAGMA table_info(admin_sessions)').all() as Array<{ name: string }>).map(
      (col) => col.name,
    )
    if (columnNames.includes('last_seen_at')) {
      // 3. 已是新 schema（全新安装 / 已迁移过）→ 仅确保索引存在（IF NOT EXISTS 幂等）
      this.db.exec(CREATE_INDEX_SQL)
      this.db.exec(CREATE_INDEX_EXPIRES_SQL)
    } else {
      // 4. 旧 schema → 事务内迁移（失败 ROLLBACK 抛错，旧表保持原样）
      this.migrateFromLegacy()
    }

    this.insertStmt = this.db.prepare(
      'INSERT INTO admin_sessions (session_id, username, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    this.getBySessionIdStmt = this.db.prepare('SELECT * FROM admin_sessions WHERE session_id = ?')
    this.deleteStmt = this.db.prepare('DELETE FROM admin_sessions WHERE session_id = ?')
    // 滑动续期：同时刷新 last_seen_at 与 expires_at
    this.touchStmt = this.db.prepare(
      'UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE session_id = ?',
    )
  }

  /**
   * 旧 schema（缺 last_seen_at）→ 新 schema 迁移，全程事务隔离（失败 ROLLBACK 抛错，旧表不丢）。
   *
   * 关键点：SQLite 的 `ALTER TABLE RENAME` **不会重命名**其上已建的用户索引——索引名仍被占用、
   * 仅 tbl_name 指向旧表。若不先 DROP，`CREATE INDEX IF NOT EXISTS` 会因名字已存在而**静默跳过**，
   * 导致新表缺失 idx_admin_sessions_username / idx_admin_sessions_expires。故迁移内先释放旧索引名。
   * 数据映射：last_used_at → last_seen_at；旧表多余的 id / ip 列直接丢弃。
   */
  private migrateFromLegacy(): void {
    // 按名字释放旧索引（若存在）：RENAME 后它们仍占用原名字并指向 admin_sessions_old
    const dropIndexIf = (name: string): void => {
      const exists = this.db
        .prepare('SELECT 1 AS one FROM sqlite_master WHERE type = ? AND name = ?')
        .get('index', name)
      if (exists !== undefined) {
        this.db.exec(`DROP INDEX ${name}`)
      }
    }
    const migrate = this.db.transaction(() => {
      this.db.exec('ALTER TABLE admin_sessions RENAME TO admin_sessions_old')
      dropIndexIf('idx_admin_sessions_username')
      dropIndexIf('idx_admin_sessions_expires')
      this.db.exec(CREATE_TABLE_SQL)
      this.db.exec(CREATE_INDEX_SQL)
      this.db.exec(CREATE_INDEX_EXPIRES_SQL)
      // 拷贝旧数据：last_used_at → last_seen_at（id / ip 丢弃）
      this.db.exec(
        'INSERT INTO admin_sessions (session_id, username, created_at, last_seen_at, expires_at) ' +
          'SELECT session_id, username, created_at, last_used_at, expires_at FROM admin_sessions_old',
      )
      this.db.exec('DROP TABLE admin_sessions_old')
    })
    migrate()
  }

  // 创建会话：返回完整行；session_id 冲突时覆盖（同账号重新登录）
  create(info: {
    sessionId: string
    username: string
    ttlMs: number
    now?: number
  }): AdminSessionRow {
    const now = info.now ?? Date.now()
    const expiresAt = now + info.ttlMs
    const existing = this.getBySessionId(info.sessionId)
    if (existing !== undefined) {
      // 同 session_id 重复登录：删除旧行再插入，保持主键唯一
      this.delete(info.sessionId)
    }
    this.insertStmt.run(info.sessionId, info.username, now, now, expiresAt)
    const row = this.getBySessionId(info.sessionId)
    if (row === undefined) {
      // 理论上不可达：DB 刚 insert 的行 read 不出来
      throw new Error('admin_session_insert_then_read_failed')
    }
    return row
  }

  // 按 session_id 读取；不存在返回 undefined
  getBySessionId(sessionId: string): AdminSessionRow | undefined {
    return this.getBySessionIdStmt.get(sessionId)
  }

  // 滑动续期：刷新 last_seen_at 与 expires_at = now + ttlMs；记录不存在则返回 false
  touch(sessionId: string, ttlMs: number, now: number = Date.now()): boolean {
    return this.touchStmt.run(now, now + ttlMs, sessionId).changes > 0
  }

  // 删除单条会话；返回是否删除成功（不存在返回 false）
  delete(sessionId: string): boolean {
    return this.deleteStmt.run(sessionId).changes > 0
  }

  // 过期清理：删除 expires_at <= now 的记录；返回删除条数供统计
  cleanup(now: number = Date.now()): number {
    const stmt = this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
    return stmt.run(now).changes
  }

  // 关闭连接（WAL 模式下关闭后数据仍持久化在 db 文件中）
  close(): void {
    this.db.close()
  }
}

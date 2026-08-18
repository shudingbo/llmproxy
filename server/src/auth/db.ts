// API Key 鉴权存储层：把"API Key 元数据 + 哈希"持久化到 ~/llmproxy/llmproxy.db
// 职责：只做存储（list/getByHash/insert/update/delete/cleanup），不做鉴权决策（由 middleware 负责）
// 安全要点：
//   - 明文 Key 仅在 create 时一次性返回；DB 仅存 SHA-256 哈希 + 前缀（用于 UI 展示与诊断）
//   - 哈希单向，无法反推明文；管理员只能「轮换」（删旧建新）无法「找回」
//   - 过期判定：expires_at = 0 表示永不过期；否则 now > expires_at 即过期
import Database from 'better-sqlite3'

// 一条 API Key 记录（与 api_keys 表字段一一对应，字段名与表列保持一致便于直接映射）
export interface ApiKeyRow {
  id: number // 主键自增
  name: string // 备注名（如 "open-webui-prod"）
  key_hash: string // SHA-256 hex 字符串（64 字符）
  key_prefix: string // 明文 Key 前 8 字符（如 "sk-1a2b3"），仅用于 UI 识别
  created_at: number // epoch ms
  expires_at: number // epoch ms；0 表示永不过期
  last_used_at: number | null // epoch ms；null 表示从未使用
  disabled: number // 0/1；SQLite 无原生 boolean，整型 0/1 表达
}

// list 分页结果：rows 为本页记录，total 为满足筛选条件的总数（不含分页）
export interface ApiKeyListResult {
  rows: ApiKeyRow[]
  total: number
}

// 新建入参：hash / prefix / expires_at 由调用方生成并传入（keyBytes 控制长度）
export interface ApiKeyInsertInfo {
  name: string
  keyHash: string
  keyPrefix: string
  expiresAt: number
}

// 更新入参：name / expiresAt / disabled 任意子集；undefined 字段保留原值
export interface ApiKeyUpdateInfo {
  name?: string
  expiresAt?: number
  disabled?: boolean
}

// 建表语句（契约固定）：id 自增主键；key_hash 建索引（鉴权热路径按 hash 查找）
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,
  key_prefix    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  disabled      INTEGER NOT NULL DEFAULT 0
);`

const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);`

// 列名清单：INSERT 与建表共用一份，避免两处手写字段列表不一致
const API_KEY_COLUMNS = ['name', 'key_hash', 'key_prefix', 'created_at', 'expires_at'] as const

export class ApiKeyStore {
  private readonly db: Database.Database

  // 预编译语句：better-sqlite3 为同步 API，不使用 async/await
  private readonly insertStmt: Database.Statement<
    [string, string, string, number, number]
  >
  private readonly getByIdStmt: Database.Statement<[number], ApiKeyRow>
  private readonly getByHashStmt: Database.Statement<[string], ApiKeyRow>
  private readonly deleteStmt: Database.Statement<[number]>
  private readonly updateStmt: Database.Statement<[string, number, number, number]>
  private readonly touchStmt: Database.Statement<[number, number]>

  /**
   * 打开（必要时创建）数据库文件：启用 WAL 日志模式，并建表、建索引。
   * 期望与 SessionStore / LogStore 共用 ~/llmproxy/llmproxy.db，WAL 多连接安全
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    // WAL：与 sessions / logs 表并发读写更友好
    this.db.pragma('journal_mode = WAL')
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(CREATE_INDEX_SQL)

    this.insertStmt = this.db.prepare(
      `INSERT INTO api_keys (${API_KEY_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`,
    )
    this.getByIdStmt = this.db.prepare('SELECT * FROM api_keys WHERE id = ?')
    this.getByHashStmt = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    this.deleteStmt = this.db.prepare('DELETE FROM api_keys WHERE id = ?')
    // UPDATE：name / expires_at / disabled 三字段一次性设置；undefined 不传，由调用方兜底
    this.updateStmt = this.db.prepare(
      'UPDATE api_keys SET name = ?, expires_at = ?, disabled = ? WHERE id = ?',
    )
    this.touchStmt = this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
  }

  // 插入一条新 Key：返回完整行（id 已生成）
  insert(info: ApiKeyInsertInfo): ApiKeyRow {
    const now = Date.now()
    const result = this.insertStmt.run(
      info.name,
      info.keyHash,
      info.keyPrefix,
      now,
      info.expiresAt,
    )
    const row = this.getByIdStmt.get(result.lastInsertRowid as number)
    if (row === undefined) {
      // 理论上不可达：DB 刚 insert 的行 read 不出来
      throw new Error('api_key_insert_then_read_failed')
    }
    return row
  }

  // 按主键读取；不存在返回 undefined
  getById(id: number): ApiKeyRow | undefined {
    return this.getByIdStmt.get(id)
  }

  // 按 hash 读取（鉴权热路径）：不存在返回 undefined
  getByHash(keyHash: string): ApiKeyRow | undefined {
    return this.getByHashStmt.get(keyHash)
  }

  // 部分更新：name / expiresAt / disabled 任意子集；空对象走 no-op
  update(id: number, info: ApiKeyUpdateInfo): boolean {
    const existing = this.getById(id)
    if (existing === undefined) {
      return false
    }
    const name = info.name ?? existing.name
    const expiresAt = info.expiresAt ?? existing.expires_at
    // disabled 字段：true → 1，false → 0；undefined → 保持原值
    const disabled = info.disabled === undefined ? existing.disabled : info.disabled ? 1 : 0
    return this.updateStmt.run(name, expiresAt, disabled, id).changes > 0
  }

  // 触摸 last_used_at = now；记录不存在则返回 false
  touch(id: number): boolean {
    return this.touchStmt.run(Date.now(), id).changes > 0
  }

  // 分页列表：id DESC（最新在前）；keyword 模糊匹配 name / key_prefix；
  // total 为满足筛选条件的总数（不含分页）
  list(opts: { offset: number; limit: number; keyword?: string; includeDisabled?: boolean }): ApiKeyListResult {
    const { offset, limit, keyword, includeDisabled } = opts
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (includeDisabled !== true) {
      conditions.push('disabled = 0')
    }
    if (keyword !== undefined && keyword !== '') {
      conditions.push('(name LIKE ? OR key_prefix LIKE ?)')
      const like = `%${keyword}%`
      params.push(like, like)
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM api_keys${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ApiKeyRow[]
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM api_keys${whereSql}`)
      .get(...params) as { total: number }
    return { rows, total: countRow.total }
  }

  // 删除单条；返回是否删除成功
  delete(id: number): boolean {
    return this.deleteStmt.run(id).changes > 0
  }

  // 过期清理：删除 (expires_at > 0 AND expires_at < now) 的记录；返回删除条数
  // 永不过期（expires_at = 0）的不受影响；返回条数供统计
  cleanupExpired(now: number = Date.now()): number {
    const stmt = this.db.prepare('DELETE FROM api_keys WHERE expires_at > 0 AND expires_at < ?')
    return stmt.run(now).changes
  }

  // 关闭连接（WAL 模式下关闭后数据仍持久化在 db 文件中）
  close(): void {
    this.db.close()
  }
}
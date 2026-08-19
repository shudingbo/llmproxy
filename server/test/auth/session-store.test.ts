// AdminSessionStore 单元测试：全新建表 / 旧 schema 迁移 / 迁移幂等 / 数据映射 / 基础读写
// 使用临时 DB 文件（tmpdir 下随机名），每个用例结束后关闭连接并删除 db/-wal/-shm 伴生文件
// 说明：AdminSessionStore 构造时直接接收 dbPath（不经过 getDataDir），故无需 stub HOME/USERPROFILE
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminSessionStore } from '../../src/auth/session-store.js'

// 生成唯一临时 DB 路径：admin-session-test-<随机hex>.db
const makeTempDbPath = (): string => join(tmpdir(), `admin-session-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 及 WAL/SHM 伴生文件（WAL 模式下同目录会产生 -wal / -shm）
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 独立只读连接查 admin_sessions 列名（WAL 模式支持并发读；用于 schema 断言）
const columnNames = (dbPath: string): string[] => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare('PRAGMA table_info(admin_sessions)').all() as Array<{ name: string }>).map((col) => col.name)
  } finally {
    db.close()
  }
}

// 独立只读连接查 admin_sessions 上的索引名（含自增 PK 的 autoindex）
const indexNames = (dbPath: string): string[] => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?').all('index', 'admin_sessions') as Array<{ name: string }>).map(
      (row) => row.name,
    )
  } finally {
    db.close()
  }
}

// 表是否仍存在
const tableExists = (dbPath: string, name: string): boolean => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare('SELECT 1 AS one FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !== undefined
  } finally {
    db.close()
  }
}

// 预置旧 schema 表（PK 为 id、字段名 last_used_at、多 ip 列）；seed=true 时插入 1 条会话
const createLegacyTable = (dbPath: string, seed: boolean): void => {
  const db = new Database(dbPath)
  try {
    db.exec(`CREATE TABLE admin_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL UNIQUE,
      username      TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      last_used_at  INTEGER NOT NULL,
      ip            TEXT
    );`)
    db.exec('CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);')
    db.exec('CREATE INDEX idx_admin_sessions_username ON admin_sessions(username);')
    if (seed) {
      db.prepare(
        'INSERT INTO admin_sessions (session_id, username, created_at, expires_at, last_used_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('legacy-sid-1', 'alice', 1000, 9999999999, 5000, '192.168.1.10')
    }
  } finally {
    db.close()
  }
}

describe('AdminSessionStore', () => {
  let dbPath = ''

  afterEach(() => {
    removeDbFiles(dbPath)
  })

  describe('全新创建场景', () => {
    it('建表后 PRAGMA table_info 含 last_seen_at 且列名/顺序符合新 schema', () => {
      dbPath = makeTempDbPath()
      const store = new AdminSessionStore(dbPath)
      try {
        expect(columnNames(dbPath)).toEqual(['session_id', 'username', 'created_at', 'last_seen_at', 'expires_at'])
      } finally {
        store.close()
      }
    })

    it('建表后两个用户索引存在', () => {
      dbPath = makeTempDbPath()
      const store = new AdminSessionStore(dbPath)
      try {
        const idx = indexNames(dbPath)
        expect(idx).toContain('idx_admin_sessions_username')
        expect(idx).toContain('idx_admin_sessions_expires')
      } finally {
        store.close()
      }
    })

    it('基础读写：create / getBySessionId / touch / delete 行为正确', () => {
      dbPath = makeTempDbPath()
      const store = new AdminSessionStore(dbPath)
      try {
        const row = store.create({ sessionId: 'sid-1', username: 'admin', ttlMs: 60_000 })
        expect(row.session_id).toBe('sid-1')
        expect(row.username).toBe('admin')
        expect(row.last_seen_at).toBeTypeOf('number')
        expect(row.expires_at).toBeGreaterThan(row.last_seen_at)
        expect(store.getBySessionId('sid-1')).toBeDefined()
        expect(store.touch('sid-1', 60_000)).toBe(true)
        expect(store.delete('sid-1')).toBe(true)
        expect(store.getBySessionId('sid-1')).toBeUndefined()
      } finally {
        store.close()
      }
    })
  })

  describe('旧 schema 迁移场景', () => {
    it('有数据旧表：迁移后新表有数据、字段名正确、id/ip/last_used_at 消失、旧表被删、索引齐全', () => {
      dbPath = makeTempDbPath()
      createLegacyTable(dbPath, true)

      const store = new AdminSessionStore(dbPath)
      try {
        // 新 schema：last_seen_at 存在，旧列 id/ip/last_used_at 消失
        const cols = columnNames(dbPath)
        expect(cols).toContain('last_seen_at')
        expect(cols).not.toContain('id')
        expect(cols).not.toContain('ip')
        expect(cols).not.toContain('last_used_at')
        // 数据被迁移：last_used_at(5000) → last_seen_at，其余字段原样
        const row = store.getBySessionId('legacy-sid-1')
        expect(row).toBeDefined()
        expect(row?.username).toBe('alice')
        expect(row?.last_seen_at).toBe(5000)
        expect(row?.created_at).toBe(1000)
        expect(row?.expires_at).toBe(9999999999)
        // 索引齐全（关键：RENAME 不重命名旧索引，需释放名字后重建）
        const idx = indexNames(dbPath)
        expect(idx).toContain('idx_admin_sessions_username')
        expect(idx).toContain('idx_admin_sessions_expires')
        // 旧表已删除
        expect(tableExists(dbPath, 'admin_sessions_old')).toBe(false)
      } finally {
        store.close()
      }
    })

    it('空旧表（无数据）也能迁移成功且可用', () => {
      dbPath = makeTempDbPath()
      createLegacyTable(dbPath, false)

      const store = new AdminSessionStore(dbPath)
      try {
        expect(columnNames(dbPath)).toContain('last_seen_at')
        expect(store.getBySessionId('anything')).toBeUndefined()
        // 迁移后表可用
        const row = store.create({ sessionId: 'new-sid', username: 'bob', ttlMs: 1000 })
        expect(row.session_id).toBe('new-sid')
        expect(store.getBySessionId('new-sid')).toBeDefined()
        // 索引齐全
        const idx = indexNames(dbPath)
        expect(idx).toContain('idx_admin_sessions_username')
        expect(idx).toContain('idx_admin_sessions_expires')
      } finally {
        store.close()
      }
    })
  })

  describe('幂等性', () => {
    it('全新表重开 store 不报错且数据仍在', () => {
      dbPath = makeTempDbPath()
      const first = new AdminSessionStore(dbPath)
      first.create({ sessionId: 'sid-persist', username: 'admin', ttlMs: 60_000 })
      first.close()

      // 重开（构造期再次检测：已是新 schema → 跳过迁移、不报错）
      const second = new AdminSessionStore(dbPath)
      try {
        expect(second.getBySessionId('sid-persist')).toBeDefined()
      } finally {
        second.close()
      }
    })

    it('迁移后的表重开 store 不报错且数据保留', () => {
      dbPath = makeTempDbPath()
      createLegacyTable(dbPath, true)
      const first = new AdminSessionStore(dbPath)
      first.close()

      // 重开：此时已是新表，应跳过迁移
      const second = new AdminSessionStore(dbPath)
      try {
        const row = second.getBySessionId('legacy-sid-1')
        expect(row).toBeDefined()
        expect(row?.last_seen_at).toBe(5000)
      } finally {
        second.close()
      }
    })
  })
})

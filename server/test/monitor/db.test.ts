// SessionMessageStore 单元测试：去重写入 / 普通写入 / 列表（limit）/ 计数 / 级联删除 / 孤儿清理 / 保留期清理 / 全量清空 / 重开持久化
// 使用临时 DB 文件（tmpdir 下随机名），每个用例结束后关闭连接并删除 db/-wal/-shm 伴生文件
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionMessageStore } from '../../src/monitor/db.js'
import { SessionStore } from '../../src/session/db.js'

// 生成唯一临时 DB 路径：monitor-test-<随机hex>.db
const makeTempDbPath = (): string => join(tmpdir(), `monitor-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 及 WAL/SHM 伴生文件（WAL 模式下同目录会产生 -wal / -shm）
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 直接用 SQL 改写 created_at（模拟时间流逝；SessionMessageStore 不暴露裸 SQL）
const setCreatedAt = (dbPath: string, id: number, createdAt: number): void => {
  const db = new Database(dbPath)
  try {
    db.prepare('UPDATE session_messages SET created_at = ? WHERE id = ?').run(createdAt, id)
  } finally {
    db.close()
  }
}

describe('SessionMessageStore', () => {
  let dbPath: string
  let store: SessionMessageStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    store = new SessionMessageStore(dbPath)
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      // 重开用例里可能已手动关闭，重复关闭会抛错，忽略即可
    }
    removeDbFiles(dbPath)
  })

  it('insertDedup：新消息写入返回行，同 (role, content) 重复返回 null', () => {
    const row1 = store.insertDedup('gpt-4::s1', 'user', '你好')
    expect(row1).not.toBeNull()
    expect(row1?.role).toBe('user')
    expect(row1?.content).toBe('你好')
    expect(row1?.session_key).toBe('gpt-4::s1')
    expect(row1?.created_at).toBeTypeOf('number')

    const dup = store.insertDedup('gpt-4::s1', 'user', '你好')
    expect(dup).toBeNull()
    expect(store.count('gpt-4::s1')).toBe(1)
  })

  it('insertDedup：同文本不同角色不去重（role 参与内容哈希）', () => {
    const a = store.insertDedup('gpt-4::s1', 'user', '你好')
    const b = store.insertDedup('gpt-4::s1', 'assistant', '你好')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(store.count('gpt-4::s1')).toBe(2)
  })

  it('insertDedup：不同会话键互不去重', () => {
    expect(store.insertDedup('gpt-4::s1', 'user', '你好')).not.toBeNull()
    expect(store.insertDedup('gpt-4::s2', 'user', '你好')).not.toBeNull()
    expect(store.count('gpt-4::s1')).toBe(1)
    expect(store.count('gpt-4::s2')).toBe(1)
  })

  it('insert：不去重，相同内容也逐条写入（assistant 回答留痕语义）', () => {
    const r1 = store.insert('gpt-4::s1', 'assistant', 'OK')
    const r2 = store.insert('gpt-4::s1', 'assistant', 'OK')
    expect(r1.id).not.toBe(r2.id)
    expect(store.count('gpt-4::s1')).toBe(2)
  })

  it('list：id 升序返回；limit 取最新 N 条（仍升序）', () => {
    store.insert('gpt-4::s1', 'user', 'm1')
    store.insert('gpt-4::s1', 'assistant', 'm2')
    store.insert('gpt-4::s1', 'user', 'm3')

    const all = store.list('gpt-4::s1')
    expect(all.map((r) => r.content)).toEqual(['m1', 'm2', 'm3'])

    const latest = store.list('gpt-4::s1', 2)
    expect(latest.map((r) => r.content)).toEqual(['m2', 'm3'])

    const unlimited = store.list('gpt-4::s1', 0)
    expect(unlimited).toHaveLength(3)
  })

  it('count：无消息会话返回 0', () => {
    expect(store.count('gpt-4::none')).toBe(0)
  })

  it('deleteBySession：删除该会话全部消息；不存在返回 0', () => {
    store.insert('gpt-4::s1', 'user', 'm1')
    store.insert('gpt-4::s2', 'user', 'm2')
    expect(store.deleteBySession('gpt-4::s1')).toBe(1)
    expect(store.count('gpt-4::s1')).toBe(0)
    expect(store.count('gpt-4::s2')).toBe(1)
    expect(store.deleteBySession('gpt-4::s1')).toBe(0)
  })

  it('deleteOrphaned：sessions 表缺失（独立测试库）返回 0 不抛错', () => {
    store.insert('gpt-4::s1', 'user', 'm1')
    expect(store.deleteOrphaned()).toBe(0)
    expect(store.count('gpt-4::s1')).toBe(1)
  })

  it('deleteOrphaned：会话映射存在则保留，缺失则级联删除', () => {
    // 同一 db 文件上建 sessions 表并绑定一条会话（与 SessionStore 共用文件的真实场景）
    const sessionStore = new SessionStore(dbPath)
    try {
      sessionStore.bind('gpt-4::kept', {
        sessionId: 'kept',
        client: 'open-webui',
        downstreamModel: 'gpt-4',
        upstreamId: 'u1',
        upstreamModel: 'u1-model',
      })
    } finally {
      sessionStore.close()
    }
    store.insert('gpt-4::kept', 'user', 'kept-msg')
    store.insert('gpt-4::gone', 'user', 'gone-msg')

    expect(store.deleteOrphaned()).toBe(1)
    expect(store.count('gpt-4::kept')).toBe(1)
    expect(store.count('gpt-4::gone')).toBe(0)
  })

  it('deleteExpired：删除 created_at 早于保留期的记录', () => {
    const r1 = store.insert('gpt-4::s1', 'user', 'old')
    const r2 = store.insert('gpt-4::s1', 'user', 'new')
    setCreatedAt(dbPath, r1.id, Date.now() - 6 * 24 * 60 * 60 * 1000) // 6 天前

    const deleted = store.deleteExpired(5 * 24 * 60 * 60 * 1000) // 保留期 5 天
    expect(deleted).toBe(1)
    expect(store.count('gpt-4::s1')).toBe(1)
    expect(store.list('gpt-4::s1')[0].id).toBe(r2.id)
  })

  it('deleteAll：清空全部（跨会话）', () => {
    store.insert('gpt-4::s1', 'user', 'm1')
    store.insert('gpt-4::s2', 'assistant', 'm2')
    expect(store.deleteAll()).toBe(2)
    expect(store.count('gpt-4::s1')).toBe(0)
    expect(store.count('gpt-4::s2')).toBe(0)
  })

  it('重开连接：数据持久化在 db 文件中', () => {
    store.insert('gpt-4::s1', 'user', 'persisted')
    store.close()

    const reopened = new SessionMessageStore(dbPath)
    try {
      expect(reopened.count('gpt-4::s1')).toBe(1)
      expect(reopened.list('gpt-4::s1')[0].content).toBe('persisted')
    } finally {
      reopened.close()
    }
  })

  it('insert：reasoning 随行落库（返回行与 list 均含）', () => {
    const row = store.insert('gpt-4::s1', 'assistant', '正文', '思考过程')
    expect(row.reasoning).toBe('思考过程')
    expect(store.list('gpt-4::s1')[0]).toMatchObject({ role: 'assistant', content: '正文', reasoning: '思考过程' })
  })

  it('insertDedup：reasoning 参与写入但不参与去重哈希；重复写入返回 null', () => {
    const row1 = store.insertDedup('gpt-4::s1', 'assistant', '你好', '思考A')
    expect(row1).not.toBeNull()
    expect(row1?.reasoning).toBe('思考A')
    // 同 (role, content) 不带 reasoning 的重复 → 去重命中，返回 null
    expect(store.insertDedup('gpt-4::s1', 'assistant', '你好')).toBeNull()
    expect(store.count('gpt-4::s1')).toBe(1)
  })

  it('insertDedup：去重命中且旧行 reasoning 为空、新值非空 → 回填旧行', () => {
    const row1 = store.insertDedup('gpt-4::s1', 'assistant', '你好')
    expect(row1).not.toBeNull()
    expect(row1?.reasoning).toBe('')
    expect(store.insertDedup('gpt-4::s1', 'assistant', '你好', '后补思考')).toBeNull()
    expect(store.list('gpt-4::s1')[0].reasoning).toBe('后补思考')
    // 已非空的 reasoning 不被空值覆盖
    expect(store.insertDedup('gpt-4::s1', 'assistant', '你好', '')).toBeNull()
    expect(store.list('gpt-4::s1')[0].reasoning).toBe('后补思考')
  })

  it('迁移：旧表（无 reasoning 列）打开时自动补列，既有行取空串默认值', () => {
    // 独立路径构造"旧版 schema"场景（0.7.0 早期构建形态），不影响主 store 的 dbPath
    const legacyPath = makeTempDbPath()
    try {
      const raw = new Database(legacyPath)
      raw.exec(
        `CREATE TABLE session_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );`,
      )
      raw
        .prepare('INSERT INTO session_messages (session_key, role, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('gpt-4::legacy', 'user', '旧行', 'h1', Date.now())
      raw.close()

      const migrated = new SessionMessageStore(legacyPath)
      try {
        // 旧行保留、reasoning 取默认空串；新写入 reasoning 正常
        const rows = migrated.list('gpt-4::legacy')
        expect(rows).toHaveLength(1)
        expect(rows[0].reasoning).toBe('')
        const inserted = migrated.insert('gpt-4::legacy', 'assistant', '新行', '新思考')
        expect(inserted.reasoning).toBe('新思考')
        expect(migrated.count('gpt-4::legacy')).toBe(2)
      } finally {
        migrated.close()
      }
    } finally {
      removeDbFiles(legacyPath)
    }
  })
})

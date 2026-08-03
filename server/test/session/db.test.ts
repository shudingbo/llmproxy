// SessionStore 单元测试：建库/绑定覆盖/触摸/改绑/分页列表/删除/清空/过期清理/重开持久化
// 使用临时 DB 文件（tmpdir 下随机名），每个用例结束后关闭连接并删除 db/-wal/-shm 伴生文件
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, type SessionBindInfo } from '../../src/session/db.js'

// 生成唯一临时 DB 路径：session-test-<随机hex>.db
const makeTempDbPath = (): string => join(tmpdir(), `session-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 及 WAL/SHM 伴生文件（WAL 模式下同目录会产生 -wal / -shm）
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 直接用 SQL 改写某条记录的 updated_at（模拟时间流逝；SessionStore 不暴露裸 SQL）
const setUpdatedAt = (dbPath: string, sessionKey: string, updatedAt: number): void => {
  const db = new Database(dbPath)
  try {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?').run(updatedAt, sessionKey)
  } finally {
    db.close()
  }
}

// 等待指定毫秒：Date.now() 精度为毫秒，断言 updated_at 增大前先让时钟前进
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 构造默认 bind 入参（可覆盖部分字段）
const makeInfo = (over: Partial<SessionBindInfo> = {}): SessionBindInfo => ({
  sessionId: 'chat-uuid-1',
  client: 'open-webui',
  downstreamModel: 'gpt-4o',
  upstreamId: 'up-1',
  upstreamModel: 'gpt-4o-azure',
  ...over,
})

describe('SessionStore', () => {
  let dbPath: string
  let store: SessionStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    store = new SessionStore(dbPath)
  })

  afterEach(() => {
    // 关闭连接（重开用例里可能已手动关闭，重复关闭会抛错，忽略即可）
    try {
      store.close()
    } catch {
      // 连接已关闭，无需处理
    }
    removeDbFiles(dbPath)
  })

  it('建库后 get 不存在 → undefined；bind 后 get → 字段完整且 created_at/updated_at 为数字', () => {
    const key = 'gpt-4o::chat-uuid-1'
    expect(store.get(key)).toBeUndefined()

    store.bind(key, makeInfo())
    const row = store.get(key)
    expect(row).toBeDefined()
    expect(row!.session_key).toBe(key)
    expect(row!.session_id).toBe('chat-uuid-1')
    expect(row!.client).toBe('open-webui')
    expect(row!.downstream_model).toBe('gpt-4o')
    expect(row!.upstream_id).toBe('up-1')
    expect(row!.upstream_model).toBe('gpt-4o-azure')
    expect(Number.isInteger(row!.created_at)).toBe(true)
    expect(row!.created_at).toBeGreaterThan(0)
    expect(Number.isInteger(row!.updated_at)).toBe(true)
    expect(row!.updated_at).toBeGreaterThan(0)
  })

  it('bind 相同 sessionKey → 覆盖更新（不抛错、新值生效、时间戳仍为数字）', () => {
    const key = 'gpt-4o::chat-uuid-1'
    store.bind(key, makeInfo())
    const before = store.get(key)!
    expect(before.created_at).toBeGreaterThan(0)

    // 同键再次绑定：改绑新的上游/会话，created_at 保留或重置由实现定，仅断言不抛错且值正确
    store.bind(key, makeInfo({ sessionId: 'chat-uuid-1b', upstreamId: 'up-2', upstreamModel: 'gpt-4o-turbo' }))
    const after = store.get(key)!
    expect(after.session_id).toBe('chat-uuid-1b')
    expect(after.upstream_id).toBe('up-2')
    expect(after.upstream_model).toBe('gpt-4o-turbo')
    expect(Number.isInteger(after.created_at)).toBe(true)
    expect(after.updated_at).toBeGreaterThanOrEqual(after.created_at)
  })

  it('touch 存在 → 返回 true 且 updated_at 变大；touch 不存在 → 返回 false', async () => {
    const key = 'gpt-4o::chat-uuid-1'
    store.bind(key, makeInfo())
    const before = store.get(key)!.updated_at

    await sleep(5) // 确保时钟前进至少 1ms
    expect(store.touch(key)).toBe(true)
    expect(store.get(key)!.updated_at).toBeGreaterThan(before)

    expect(store.touch('gpt-4o::no-such-key')).toBe(false)
  })

  it('rebind 后 upstream_id / upstream_model 更新且 updated_at 刷新；不存在则忽略不抛错', async () => {
    const key = 'gpt-4o::chat-uuid-1'
    store.bind(key, makeInfo())
    const before = store.get(key)!.updated_at

    await sleep(5)
    store.rebind(key, 'up-9', 'gpt-4o-0913')
    const row = store.get(key)!
    expect(row.upstream_id).toBe('up-9')
    expect(row.upstream_model).toBe('gpt-4o-0913')
    expect(row.updated_at).toBeGreaterThan(before)

    expect(() => store.rebind('gpt-4o::no-such-key', 'up-9', 'gpt-4o-0913')).not.toThrow()
  })

  it('list：updated_at 倒序、offset/limit 分页、client 筛选、keyword 模糊匹配、total 正确', () => {
    store.bind('gpt-4o::chat-1', makeInfo({ sessionId: 'sess-alpha', upstreamId: 'up-alpha' }))
    store.bind(
      'gpt-4o::chat-2',
      makeInfo({ sessionId: 'sess-beta', upstreamId: 'up-beta', client: 'content-hash' }),
    )
    store.bind('gpt-4o::chat-3', makeInfo({ sessionId: 'sess-gamma', upstreamId: 'up-gamma' }))
    // 手动错开 updated_at，保证排序断言确定（不依赖 bind 的先后时序）
    setUpdatedAt(dbPath, 'gpt-4o::chat-1', 100)
    setUpdatedAt(dbPath, 'gpt-4o::chat-2', 200)
    setUpdatedAt(dbPath, 'gpt-4o::chat-3', 300)

    // 全部：倒序
    const all = store.list({ offset: 0, limit: 10 })
    expect(all.total).toBe(3)
    expect(all.rows.map((r) => r.session_key)).toEqual(['gpt-4o::chat-3', 'gpt-4o::chat-2', 'gpt-4o::chat-1'])

    // 分页：offset=1 limit=1 → 中间那条，total 不受分页影响
    const page = store.list({ offset: 1, limit: 1 })
    expect(page.rows.map((r) => r.session_key)).toEqual(['gpt-4o::chat-2'])
    expect(page.total).toBe(3)

    // client 精确筛选
    const openWebui = store.list({ offset: 0, limit: 10, client: 'open-webui' })
    expect(openWebui.total).toBe(2)
    expect(openWebui.rows.map((r) => r.session_key)).toEqual(['gpt-4o::chat-3', 'gpt-4o::chat-1'])

    // keyword 命中 session_id
    const bySession = store.list({ offset: 0, limit: 10, keyword: 'beta' })
    expect(bySession.total).toBe(1)
    expect(bySession.rows[0].session_id).toBe('sess-beta')

    // keyword 命中 upstream_id
    const byUpstream = store.list({ offset: 0, limit: 10, keyword: 'up-gamma' })
    expect(byUpstream.total).toBe(1)
    expect(byUpstream.rows[0].upstream_id).toBe('up-gamma')

    // keyword 无匹配 → 空列表、total 0
    const none = store.list({ offset: 0, limit: 10, keyword: 'zzz-no-match' })
    expect(none.rows).toEqual([])
    expect(none.total).toBe(0)
  })

  it('delete 存在 → 返回 true 且 get 为 undefined；delete 不存在 → 返回 false', () => {
    const key = 'gpt-4o::chat-uuid-1'
    store.bind(key, makeInfo())

    expect(store.delete(key)).toBe(true)
    expect(store.get(key)).toBeUndefined()
    expect(store.delete(key)).toBe(false)
  })

  it('clear 返回删除条数且表为空；再清一次返回 0', () => {
    store.bind('gpt-4o::chat-a', makeInfo({ sessionId: 'sess-a' }))
    store.bind('gpt-4o::chat-b', makeInfo({ sessionId: 'sess-b' }))

    expect(store.clear()).toBe(2)
    expect(store.list({ offset: 0, limit: 10 }).total).toBe(0)
    expect(store.clear()).toBe(0)
  })

  it('cleanup 只删过期记录（updated_at < now - maxAgeMs）并返回正确条数', () => {
    const now = Date.now()
    store.bind('gpt-4o::chat-old', makeInfo({ sessionId: 'sess-old' }))
    store.bind('gpt-4o::chat-new', makeInfo({ sessionId: 'sess-new' }))
    // 模拟时间流逝：旧记录 10 万 ms 前、新记录 1 千 ms 前
    setUpdatedAt(dbPath, 'gpt-4o::chat-old', now - 100_000)
    setUpdatedAt(dbPath, 'gpt-4o::chat-new', now - 1_000)

    // maxAge 5 万 ms：只删旧记录
    expect(store.cleanup(50_000)).toBe(1)
    expect(store.get('gpt-4o::chat-old')).toBeUndefined()
    expect(store.get('gpt-4o::chat-new')).toBeDefined()

    // 再次清理（maxAge=500：删 updated_at < now-500）→ 新记录（now-1000）也被删；
    // 因 Date.now() ≥ now 恒成立，该断言不依赖测试耗时
    expect(store.cleanup(500)).toBe(1)
    expect(store.get('gpt-4o::chat-new')).toBeUndefined()
  })

  it('close 后重新 open 同一文件 → 不报错且数据仍在', () => {
    const key = 'gpt-4o::chat-uuid-1'
    store.bind(key, makeInfo({ upstreamId: 'up-7' }))
    store.close()

    // 重开同一路径：数据持久化在 db 文件中
    const reopened = new SessionStore(dbPath)
    try {
      const row = reopened.get(key)
      expect(row).toBeDefined()
      expect(row!.session_id).toBe('chat-uuid-1')
      expect(row!.upstream_id).toBe('up-7')
    } finally {
      reopened.close()
    }
  })
})

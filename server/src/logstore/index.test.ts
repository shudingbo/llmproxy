// LogStore 单元测试：建库/插入（可选字段存 NULL）/排序分页/过滤/过期清理/重开持久化
// 使用临时 DB 文件（tmpdir 下随机名），每个用例结束后关闭连接并删除 db/-wal/-shm 伴生文件
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogStore, type LogQueryOptions } from './index.js'

// 生成唯一临时 DB 路径：logstore-test-<随机hex>.db
const makeTempDbPath = (): string => join(tmpdir(), `logstore-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 及 WAL/SHM 伴生文件（WAL 模式下同目录会产生 -wal / -shm）
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 直接用 SQL 改写某条记录的 time（模拟时间流逝；LogStore 不暴露裸 SQL）
const setTime = (dbPath: string, id: number, time: number): void => {
  const db = new Database(dbPath)
  try {
    db.prepare('UPDATE logs SET time = ? WHERE id = ?').run(time, id)
  } finally {
    db.close()
  }
}

// 构造默认 query 入参（可覆盖部分字段）：type 必填，时间范围默认全开
const makeQuery = (over: Partial<LogQueryOptions> = {}): LogQueryOptions => ({
  type: 'app',
  from: 0,
  to: Number.MAX_SAFE_INTEGER,
  minLevel: 0,
  offset: 0,
  limit: 10,
  ...over,
})

describe('LogStore', () => {
  let dbPath: string
  let store: LogStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    store = new LogStore(dbPath)
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

  it('建库后 query 空库 → rows 为空、total 为 0', () => {
    const res = store.query(makeQuery())
    expect(res.rows).toEqual([])
    expect(res.total).toBe(0)
  })

  it('insert 一条后 query → 字段完整（snake_case 列名）、total 为 1；可选字段缺省存 NULL', () => {
    store.insert({
      type: 'api',
      level: 30,
      time: 1_000,
      msg: 'GET /v1/chat/completions 200',
      category: 'proxy',
      requestId: 'req-1',
      method: 'GET',
      url: '/v1/chat/completions',
      status: 200,
      durationMs: 123.5,
      raw: '{"level":30,"msg":"GET /v1/chat/completions 200"}',
    })
    const res = store.query(makeQuery({ type: 'api' }))
    expect(res.total).toBe(1)
    const row = res.rows[0]
    expect(Number.isInteger(row.id)).toBe(true)
    expect(row.id).toBeGreaterThan(0)
    expect(row.type).toBe('api')
    expect(row.level).toBe(30)
    expect(row.time).toBe(1_000)
    expect(row.msg).toBe('GET /v1/chat/completions 200')
    expect(row.category).toBe('proxy')
    expect(row.request_id).toBe('req-1')
    expect(row.method).toBe('GET')
    expect(row.url).toBe('/v1/chat/completions')
    expect(row.status).toBe(200)
    expect(row.duration_ms).toBe(123.5)
    expect(row.raw).toBe('{"level":30,"msg":"GET /v1/chat/completions 200"}')

    // 可选字段缺省（undefined）→ 入库为 NULL
    store.insert({ type: 'app', level: 40, time: 2_000 })
    const minimal = store.query(makeQuery({ type: 'app' }))
    expect(minimal.total).toBe(1)
    const minimalRow = minimal.rows[0]
    expect(minimalRow.msg).toBeNull()
    expect(minimalRow.category).toBeNull()
    expect(minimalRow.request_id).toBeNull()
    expect(minimalRow.method).toBeNull()
    expect(minimalRow.url).toBeNull()
    expect(minimalRow.status).toBeNull()
    expect(minimalRow.duration_ms).toBeNull()
    expect(minimalRow.raw).toBeNull()
  })

  it('多条插入：time DESC、id DESC 倒序，offset/limit 分页正确，total 不含分页', () => {
    // 打乱 time 插入；再插两条相同 time，验证同 time 时按 id DESC（后插在前）稳定排序
    store.insert({ type: 'app', level: 30, time: 100, msg: 'a' })
    store.insert({ type: 'app', level: 30, time: 300, msg: 'c' })
    store.insert({ type: 'app', level: 30, time: 200, msg: 'b' })
    store.insert({ type: 'app', level: 30, time: 300, msg: 'c2' })

    const all = store.query(makeQuery())
    expect(all.total).toBe(4)
    expect(all.rows.map((r) => `${r.time}:${r.msg}`)).toEqual(['300:c2', '300:c', '200:b', '100:a'])

    // 分页：offset=1 limit=2 → 中间两条，total 不受分页影响
    const page = store.query(makeQuery({ offset: 1, limit: 2 }))
    expect(page.rows.map((r) => r.msg)).toEqual(['c', 'b'])
    expect(page.total).toBe(4)
  })

  it('query 过滤：type 互不干扰、time 范围边界含、minLevel、keyword 命中 msg/url/request_id/category 任一', () => {
    store.insert({ type: 'app', level: 20, time: 100, msg: 'app-startup', category: 'bootstrap' })
    store.insert({
      type: 'api',
      level: 30,
      time: 200,
      msg: 'GET /ok 200',
      requestId: 'req-alpha',
      method: 'GET',
      url: '/ok',
      status: 200,
    })
    store.insert({ type: 'app', level: 40, time: 300, msg: 'app-loop', category: 'bootstrap' })
    store.insert({
      type: 'api',
      level: 50,
      time: 400,
      msg: 'POST /chat 500',
      requestId: 'req-beta',
      method: 'POST',
      url: '/chat',
      status: 500,
    })
    store.insert({ type: 'app', level: 60, time: 500, msg: 'app-shutdown', category: 'bootstrap' })

    // type 过滤：app 与 api 互不干扰
    const apps = store.query(makeQuery({ type: 'app' }))
    expect(apps.total).toBe(3)
    expect(apps.rows.every((r) => r.type === 'app')).toBe(true)
    const apis = store.query(makeQuery({ type: 'api' }))
    expect(apis.total).toBe(2)
    expect(apis.rows.every((r) => r.type === 'api')).toBe(true)

    // time 范围：from/to 边界含（100 与 300 都应返回）
    const inRange = store.query(makeQuery({ type: 'app', from: 100, to: 300 }))
    expect(inRange.total).toBe(2)
    expect(inRange.rows.map((r) => r.time)).toEqual([300, 100])

    // minLevel：level >= 30 的记录才返回
    const above = store.query(makeQuery({ type: 'app', minLevel: 30 }))
    expect(above.total).toBe(2)
    expect(above.rows.every((r) => r.level >= 30)).toBe(true)

    // keyword 命中 msg
    const byMsg = store.query(makeQuery({ type: 'app', keyword: 'startup' }))
    expect(byMsg.total).toBe(1)
    expect(byMsg.rows[0].msg).toBe('app-startup')

    // keyword 命中 url
    const byUrl = store.query(makeQuery({ type: 'api', keyword: '/chat' }))
    expect(byUrl.total).toBe(1)
    expect(byUrl.rows[0].url).toBe('/chat')

    // keyword 命中 request_id
    const byReq = store.query(makeQuery({ type: 'api', keyword: 'req-alpha' }))
    expect(byReq.total).toBe(1)
    expect(byReq.rows[0].request_id).toBe('req-alpha')

    // keyword 命中 category（多条）
    const byCat = store.query(makeQuery({ type: 'app', keyword: 'bootstrap' }))
    expect(byCat.total).toBe(3)

    // keyword 无匹配 → 空列表、total 0
    const none = store.query(makeQuery({ keyword: 'zzz-no-match' }))
    expect(none.rows).toEqual([])
    expect(none.total).toBe(0)
  })

  it('cleanup 只删过期记录（time < now - maxAgeMs）并返回正确条数', () => {
    const now = Date.now()
    store.insert({ type: 'app', level: 30, time: now, msg: 'old' })
    store.insert({ type: 'app', level: 30, time: now, msg: 'new' })
    const all = store.query(makeQuery())
    const oldRow = all.rows.find((r) => r.msg === 'old')
    const newRow = all.rows.find((r) => r.msg === 'new')
    if (oldRow === undefined || newRow === undefined) {
      throw new Error('测试数据未完整插入')
    }
    // 模拟时间流逝：旧记录 10 万 ms 前、新记录 2 千 ms 前
    setTime(dbPath, oldRow.id, now - 100_000)
    setTime(dbPath, newRow.id, now - 2_000)

    // maxAge 5 万 ms：只删旧记录（新记录 now-2000 仍在新阈值之内）
    expect(store.cleanup(50_000)).toBe(1)
    const afterFirst = store.query(makeQuery())
    expect(afterFirst.total).toBe(1)
    expect(afterFirst.rows[0].msg).toBe('new')

    // 再次清理（maxAge=500：删 time < now-500）→ 新记录（now-2000）也被删；
    // 因 Date.now() ≥ now 恒成立（now - 2000 < now - 500 必真），该断言不依赖测试耗时
    expect(store.cleanup(500)).toBe(1)
    expect(store.query(makeQuery()).total).toBe(0)
  })

  it('deleteBefore 删除 time < before 的记录并返回条数；before 大于全部 time 时全删', () => {
    store.insert({ type: 'app', level: 30, time: 1_000, msg: 'old-1' })
    store.insert({ type: 'app', level: 30, time: 2_000, msg: 'old-2' })
    store.insert({ type: 'app', level: 30, time: 3_000, msg: 'keep' })

    // before=2500：只删 time<2500 的两条旧记录（1000/2000），3000 保留（time == before 不匹配 <）
    expect(store.deleteBefore(2_500)).toBe(2)
    const after = store.query(makeQuery())
    expect(after.total).toBe(1)
    expect(after.rows[0].msg).toBe('keep')

    // before 大于所有 time → 全部删除
    expect(store.deleteBefore(Number.MAX_SAFE_INTEGER)).toBe(1)
    expect(store.query(makeQuery()).total).toBe(0)
  })

  it('close 后重新 open 同一文件 → 不报错且数据仍在', () => {
    store.insert({ type: 'app', level: 30, time: 1_000, msg: 'persist-me' })
    store.close()

    // 重开同一路径：数据持久化在 db 文件中
    const reopened = new LogStore(dbPath)
    try {
      const res = reopened.query(makeQuery())
      expect(res.total).toBe(1)
      expect(res.rows[0].msg).toBe('persist-me')
    } finally {
      reopened.close()
    }
  })
})

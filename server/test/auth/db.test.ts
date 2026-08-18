// ApiKeyStore 单元测试：建表 / 插入 / 哈希查找 / 更新 / 分页列表 / 过期清理 / 重开持久化
// 遵循已有 session/db.test.ts 的临时 DB 文件模式：tmpdir + 随机 hex + 关闭后删除 -wal/-shm
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../../src/auth/db.js'
import { extractKeyPrefix, generateApiKey, hashApiKey } from '../../src/auth/key.js'

// 唯一临时 DB 路径
const makeTempDbPath = (): string => join(tmpdir(), `apikey-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 与 WAL/SHM 伴生文件
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 构造一条新 Key 的元数据（明文 key 仅用于测试，hash/prefix 派生自它）
// 用 32 字节让 hex 段更长；但 prefix 仍是首 8 字符，因此不同 Key 的 prefix 可能相同，
// 测试中要做 keyword 区分时改用 name
const makeKey = (keyBytes = 16): { plain: string; hash: string; prefix: string } => {
  const plain = generateApiKey(keyBytes)
  return { plain, hash: hashApiKey(plain), prefix: extractKeyPrefix(plain) }
}

// 用于 keyword prefix 测试的自定义 prefix（避开 generateApiKey 的固定前缀 'sk-llmpr'）
const customPrefix = (suffix: string): string => `sk-test-${suffix}`

describe('ApiKeyStore', () => {
  let dbPath: string
  let store: ApiKeyStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    store = new ApiKeyStore(dbPath)
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      // 重复关闭忽略
    }
    removeDbFiles(dbPath)
  })

  it('建库后表存在；插入单条返回完整行（id 自增、时间戳为数字、disabled=0）', () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'open-webui-prod', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })
    expect(row.id).toBeGreaterThan(0)
    expect(row.name).toBe('open-webui-prod')
    expect(row.key_hash).toBe(hash)
    expect(row.key_prefix).toBe(prefix)
    expect(row.expires_at).toBe(0)
    expect(row.disabled).toBe(0)
    expect(Number.isInteger(row.created_at)).toBe(true)
    expect(row.created_at).toBeGreaterThan(0)
    expect(row.last_used_at).toBeNull()
  })

  it('getByHash 命中插入的 hash；不存在 → undefined；不同 hash 不命中', () => {
    const { hash } = makeKey()
    const row = store.insert({ name: 'k1', keyHash: hash, keyPrefix: 'sk-prefix', expiresAt: 0 })
    const found = store.getByHash(hash)
    expect(found).toBeDefined()
    expect(found!.id).toBe(row.id)
    expect(store.getByHash('not-existing-hash')).toBeUndefined()
  })

  it('getById 命中插入的 id；不存在 → undefined', () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'k1', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })
    expect(store.getById(row.id)).toBeDefined()
    expect(store.getById(99999)).toBeUndefined()
  })

  it('touch 存在 → 返回 true 且 last_used_at 由 null 变为 now；不存在 → 返回 false', async () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'k1', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })
    expect(row.last_used_at).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    expect(store.touch(row.id)).toBe(true)
    const after = store.getById(row.id)!
    expect(after.last_used_at).not.toBeNull()
    expect(after.last_used_at!).toBeGreaterThan(0)
    expect(store.touch(99999)).toBe(false)
  })

  it('update 修改 name / expiresAt / disabled；undefined 字段不覆盖；记录不存在返回 false', () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'original', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })

    // 仅改 name
    expect(store.update(row.id, { name: 'renamed' })).toBe(true)
    const r1 = store.getById(row.id)!
    expect(r1.name).toBe('renamed')
    expect(r1.expires_at).toBe(0)
    expect(r1.disabled).toBe(0)

    // 仅改 expiresAt
    expect(store.update(row.id, { expiresAt: 999999999999 })).toBe(true)
    const r2 = store.getById(row.id)!
    expect(r2.name).toBe('renamed')
    expect(r2.expires_at).toBe(999999999999)

    // 仅改 disabled
    expect(store.update(row.id, { disabled: true })).toBe(true)
    const r3 = store.getById(row.id)!
    expect(r3.disabled).toBe(1)

    // 改回 disabled=false
    expect(store.update(row.id, { disabled: false })).toBe(true)
    const r4 = store.getById(row.id)!
    expect(r4.disabled).toBe(0)

    // 不存在的 id
    expect(store.update(99999, { name: 'x' })).toBe(false)
  })

  it('list 默认不含 disabled 记录；includeDisabled=true 全部返回', () => {
    const k1 = makeKey()
    const k2 = makeKey()
    const k3 = makeKey()
    const row1 = store.insert({ name: 'active-1', keyHash: k1.hash, keyPrefix: k1.prefix, expiresAt: 0 })
    store.insert({ name: 'active-2', keyHash: k2.hash, keyPrefix: k2.prefix, expiresAt: 0 })
    store.insert({ name: 'disabled-1', keyHash: k3.hash, keyPrefix: k3.prefix, expiresAt: 0 })
    // 停用 active-1（row1 是 active-1 的 id）
    expect(store.update(row1.id, { disabled: true })).toBe(true)
    // 校验：row1 当前 disabled=1
    expect(store.getById(row1.id)!.disabled).toBe(1)

    // 不含 disabled → 只剩 active-2 + disabled-1 中的 disabled-1？不对，应该是 active-2 一条
    // 注：active-1 被停用、disabled-1 创建时就 disabled=0。等等，看上面创建代码：disabled-1 没有显式停用，
    // 所以 disabled-1 还是 0。active-1 已被停用 → active-1 disabled=1。
    // → 只剩 active-2 + disabled-1 共 2 条
    const onlyActive = store.list({ offset: 0, limit: 10 })
    expect(onlyActive.total).toBe(2)
    const activeNames = onlyActive.rows.map((r) => r.name).sort()
    expect(activeNames).toEqual(['active-2', 'disabled-1'])

    // includeDisabled=true → 全 3 条
    const all = store.list({ offset: 0, limit: 10, includeDisabled: true })
    expect(all.total).toBe(3)
  })

  it('list：id DESC 倒序、offset/limit 分页、keyword 模糊匹配 name/key_prefix、total 正确', () => {
    // 用自定义 prefix（每条唯一）确保 keyword 测试不冲突
    const a = makeKey()
    const b = makeKey()
    const c = makeKey()
    store.insert({ name: 'alpha', keyHash: a.hash, keyPrefix: customPrefix('alph'), expiresAt: 0 })
    store.insert({ name: 'beta', keyHash: b.hash, keyPrefix: customPrefix('beta'), expiresAt: 0 })
    store.insert({ name: 'gamma', keyHash: c.hash, keyPrefix: customPrefix('gamm'), expiresAt: 0 })

    // 全部：id DESC
    const all = store.list({ offset: 0, limit: 10, includeDisabled: true })
    expect(all.total).toBe(3)
    // id 单调：gamma(3) > beta(2) > alpha(1)
    expect(all.rows.map((r) => r.name)).toEqual(['gamma', 'beta', 'alpha'])

    // 分页
    const page = store.list({ offset: 1, limit: 1, includeDisabled: true })
    expect(page.rows.map((r) => r.name)).toEqual(['beta'])
    expect(page.total).toBe(3)

    // keyword 匹配 name
    const byName = store.list({ offset: 0, limit: 10, keyword: 'bet' })
    expect(byName.total).toBe(1)
    expect(byName.rows[0].name).toBe('beta')

    // keyword 匹配 prefix（每条 prefix 唯一，避免全部命中）
    const byPrefix = store.list({ offset: 0, limit: 10, keyword: customPrefix('alph') })
    expect(byPrefix.total).toBe(1)
    expect(byPrefix.rows[0].name).toBe('alpha')

    // 无匹配
    const none = store.list({ offset: 0, limit: 10, keyword: 'zzz' })
    expect(none.rows).toEqual([])
    expect(none.total).toBe(0)
  })

  it('delete 存在 → 返回 true 且 getById 为 undefined；不存在 → false', () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'k1', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })

    expect(store.delete(row.id)).toBe(true)
    expect(store.getById(row.id)).toBeUndefined()
    expect(store.delete(row.id)).toBe(false)
  })

  it('cleanupExpired：retentionDays=0 → 过期即清理（默认行为）；永不过期与未过期保留', () => {
    const { hash: h1, prefix: p1 } = makeKey()
    const { hash: h2, prefix: p2 } = makeKey()
    const { hash: h3, prefix: p3 } = makeKey()
    const now = Date.now()
    store.insert({ name: 'forever', keyHash: h1, keyPrefix: p1, expiresAt: 0 })
    store.insert({ name: 'expired', keyHash: h2, keyPrefix: p2, expiresAt: now - 1000 })
    store.insert({ name: 'valid', keyHash: h3, keyPrefix: p3, expiresAt: now + 60000 })

    // retentionDays=0 → cutoff = now：过期（expired）被删；forever (0) 不动；valid (>now) 保留
    const deleted = store.cleanupExpired(0, now)
    expect(deleted).toBe(1)
    // expired 行已删
    expect(store.list({ offset: 0, limit: 10, keyword: 'expired', includeDisabled: true }).total).toBe(0)
    // forever 与 valid 仍在
    expect(store.list({ offset: 0, limit: 10, includeDisabled: true }).total).toBe(2)
  })

  it('cleanupExpired：retentionDays>0 → 仅清理「已过期 N 天以上」的记录', () => {
    const { hash: h1, prefix: p1 } = makeKey()
    const { hash: h2, prefix: p2 } = makeKey()
    const { hash: h3, prefix: p3 } = makeKey()
    const { hash: h4, prefix: p4 } = makeKey()
    const now = Date.now()
    const day = 86400000
    // 永不过期
    store.insert({ name: 'forever', keyHash: h1, keyPrefix: p1, expiresAt: 0 })
    // 刚过期 1 天（保留期内）
    store.insert({ name: 'fresh-expired', keyHash: h2, keyPrefix: p2, expiresAt: now - 1 * day })
    // 已过期 30 天（保留期外）
    store.insert({ name: 'stale-expired', keyHash: h3, keyPrefix: p3, expiresAt: now - 30 * day })
    // 未来 60 天
    store.insert({ name: 'future', keyHash: h4, keyPrefix: p4, expiresAt: now + 60 * day })

    // retentionDays=7：cutoff = now - 7*day
    // → fresh-expired (now - 1d) > cutoff → 保留
    // → stale-expired (now - 30d) < cutoff → 清理
    // → forever 与 future 不动
    const deleted = store.cleanupExpired(7, now)
    expect(deleted).toBe(1)
    // 剩余 3 条
    expect(store.list({ offset: 0, limit: 10, includeDisabled: true }).total).toBe(3)
    // stale-expired 已删
    expect(store.list({ offset: 0, limit: 10, keyword: 'stale', includeDisabled: true }).total).toBe(0)
    // fresh-expired 仍存在（保留期内未到清理阈值）
    expect(store.list({ offset: 0, limit: 10, keyword: 'fresh', includeDisabled: true }).total).toBe(1)
  })

  it('cleanupExpired：retentionDays 缺省（0）时等价于过期即清理', () => {
    const { hash, prefix } = makeKey()
    const now = Date.now()
    store.insert({ name: 'just-expired', keyHash: hash, keyPrefix: prefix, expiresAt: now - 1000 })
    // 不传 retentionDays → 走缺省 0 → 过期即清
    expect(store.cleanupExpired(undefined, now)).toBe(1)
  })

  it('close 后重新 open 同一文件 → 数据仍在', () => {
    const { hash, prefix } = makeKey()
    const row = store.insert({ name: 'persist-test', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })
    store.close()

    const reopened = new ApiKeyStore(dbPath)
    try {
      const found = reopened.getById(row.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe('persist-test')
      expect(found!.key_hash).toBe(hash)
    } finally {
      reopened.close()
    }
  })

  it('UNIQUE 约束：相同 hash 第二次插入抛错（SQLITE_CONSTRAINT）', () => {
    const { hash, prefix } = makeKey()
    store.insert({ name: 'first', keyHash: hash, keyPrefix: prefix, expiresAt: 0 })
    expect(() =>
      store.insert({ name: 'second', keyHash: hash, keyPrefix: prefix, expiresAt: 0 }),
    ).toThrow(/UNIQUE|SQLITE_CONSTRAINT/)
  })

  it('可与外部 SQLite 工具读写：建表 / WAL 与现有 session/log 表兼容', () => {
    // 验证 ApiKeyStore 建表 SQL 与同目录下其他表兼容：手动打开 DB 再 SELECT
    const db = new Database(dbPath)
    try {
      // api_keys 表已建
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
        .get() as { name: string } | undefined
      expect(tables?.name).toBe('api_keys')
      // 索引已建
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_api_keys_hash'")
        .get() as { name: string } | undefined
      expect(idx?.name).toBe('idx_api_keys_hash')
    } finally {
      db.close()
    }
  })
})

describe('auth/key 工具', () => {
  it('generateApiKey 默认 24 字节 → 形如 sk-llmproxy-<48 hex>（24*2=48 字符）', () => {
    const k = generateApiKey()
    expect(k.startsWith('sk-llmproxy-')).toBe(true)
    expect(k.length).toBe('sk-llmproxy-'.length + 48)
  })

  it('hashApiKey：相同明文 → 相同 64 字符 hex；不同明文 → 不同 hash', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    const ha = hashApiKey(a)
    const hb = hashApiKey(b)
    expect(ha).toHaveLength(64)
    expect(hb).toHaveLength(64)
    expect(ha).not.toBe(hb)
    expect(hashApiKey(a)).toBe(ha) // 幂等
  })

  it('extractKeyPrefix 取前 8 字符', () => {
    expect(extractKeyPrefix('sk-llmproxy-abcdef1234')).toBe('sk-llmpr')
  })
})
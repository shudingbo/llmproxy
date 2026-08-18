// 鉴权中间件 + 管理端 CRUD 路由集成测试：supertest 打真实中间件 + 真实 ApiKeyStore
// 覆盖：开关关闭旁路、缺失/格式错误 Authorization 401、合法 Key 200、过期/停用 Key 401、
//       列表分页、创建返回明文一次、更新/删除/状态查询、PUT/DELETE 路径参数校验
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import type { Config } from '../../src/config/schema.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { createAuthMiddleware } from '../../src/auth/middleware.js'
import { extractKeyPrefix, generateApiKey, hashApiKey } from '../../src/auth/key.js'
import { LogStore } from '../../src/logstore/index.js'
import { SessionStore } from '../../src/session/db.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { registerAdminRoutes } from '../../src/server/admin.js'

const BASE_CONFIG: Config = {
  upstreams: [
    {
      id: 'u1',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-x',
      timeoutMs: 5000,
      disabled: false,
      responsesApi: 'convert',
    },
  ],
  downstreamModels: {
    'gpt-4': {
      disabled: false,
      candidates: [{ upstreamId: 'u1', model: 'gpt-4' }],
    },
  },
}

let tmpDir: string
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let logStore: LogStore
let apiKeyStore: ApiKeyStore
let app: Express
let clients: Map<string, unknown>

function buildApp(): void {
  app = express()
  app.use(express.json())
  // 模拟装配层：先挂鉴权中间件到 /v1，再挂一个假的下游 handler；管理端 /admin 不挂鉴权
  app.use('/v1', createAuthMiddleware({ store, apiKeyStore }))
  app.get('/v1/models', (_req, res) => {
    res.json({ ok: true })
  })
  // 注册管理端路由（包含 /admin/api/keys CRUD）
  registerAdminRoutes(app, {
    store,
    getUpstreamClient: (id) => clients.get(id) as never,
    stats,
    sessionStore,
    logStore,
    apiKeyStore,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-auth-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  sessionStore = new SessionStore(join(tmpDir, 'sessions.db'))
  logStore = new LogStore(join(tmpDir, 'logs.db'))
  apiKeyStore = new ApiKeyStore(join(tmpDir, 'apikeys.db'))
  clients = new Map()
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
  buildApp()
})

afterEach(() => {
  vi.unstubAllEnvs()
  try { sessionStore.close() } catch {}
  try { logStore.close() } catch {}
  try { apiKeyStore.close() } catch {}
  rmSync(tmpDir, { recursive: true, force: true })
})

// 直接用 SQL 把 expires_at 改成过去时间，模拟过期（不暴露裸 SQL 给生产代码）
const setExpiresAt = (id: number, ts: number): void => {
  const db = new Database(join(tmpDir, 'apikeys.db'))
  try {
    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(ts, id)
  } finally {
    db.close()
  }
}

describe('鉴权中间件 createAuthMiddleware', () => {
  it('auth.enabled 未设置（缺省 false）→ 任何请求均旁路，不读 header、不查 DB', async () => {
    // store.get().auth === undefined → enabled !== true → 直接 next()
    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(200)
    // 带任意 Authorization 也不影响
    const res2 = await request(app).get('/v1/models').set('Authorization', 'Bearer random')
    expect(res2.status).toBe(200)
  })

  it('auth.enabled=true 但 DB 中无 Key → 缺失 Authorization 返回 401', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('missing_or_malformed_authorization')
    expect(res.headers['www-authenticate']).toBe('Bearer realm="llmproxy"')
  })

  it('auth.enabled=true 但格式错误（不带 Bearer / 空 token）→ 401', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const r1 = await request(app).get('/v1/models').set('Authorization', 'Basic abc')
    expect(r1.status).toBe(401)
    expect(r1.body.code).toBe('missing_or_malformed_authorization')
    const r2 = await request(app).get('/v1/models').set('Authorization', 'Bearer    ')
    expect(r2.status).toBe(401)
  })

  it('auth.enabled=true 携带合法 Key → 200，并通过 last_used_at 触摸', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const plain = generateApiKey()
    const row = apiKeyStore.insert({
      name: 'test',
      keyHash: hashApiKey(plain),
      keyPrefix: extractKeyPrefix(plain),
      expiresAt: 0,
    })
    expect(row.last_used_at).toBeNull()

    const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${plain}`)
    expect(res.status).toBe(200)
    // 触摸后 last_used_at 不再为 null
    const after = apiKeyStore.getById(row.id)!
    expect(after.last_used_at).not.toBeNull()
  })

  it('auth.enabled=true 携带错误 Key → 401（unknown_api_key）', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const res = await request(app)
      .get('/v1/models')
      .set('Authorization', 'Bearer sk-llmproxy-wrong-key-zzzzz')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('unknown_api_key')
  })

  it('auth.enabled=true 携带已停用 Key → 401（unknown_api_key，与不存在同形）', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const plain = generateApiKey()
    const row = apiKeyStore.insert({
      name: 'stopped',
      keyHash: hashApiKey(plain),
      keyPrefix: extractKeyPrefix(plain),
      expiresAt: 0,
    })
    apiKeyStore.update(row.id, { disabled: true })
    const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${plain}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('unknown_api_key')
  })

  it('auth.enabled=true 携带已过期 Key → 401（expired_api_key）', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const plain = generateApiKey()
    const row = apiKeyStore.insert({
      name: 'old',
      keyHash: hashApiKey(plain),
      keyPrefix: extractKeyPrefix(plain),
      expiresAt: Date.now() + 60_000,
    })
    // 强制改为过去
    setExpiresAt(row.id, Date.now() - 1000)
    const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${plain}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('expired_api_key')
  })

  it('auth.enabled=true 配置热切换：关闭后立即旁路', async () => {
    // 先开启
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const plain = generateApiKey()
    apiKeyStore.insert({
      name: 'x',
      keyHash: hashApiKey(plain),
      keyPrefix: extractKeyPrefix(plain),
      expiresAt: 0,
    })
    // 开启时无 token → 401
    const r1 = await request(app).get('/v1/models')
    expect(r1.status).toBe(401)
    // 关闭
    store.set({ ...BASE_CONFIG, auth: { enabled: false, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const r2 = await request(app).get('/v1/models')
    expect(r2.status).toBe(200)
  })

  it('Bearer 大小写不敏感：bearer / BEARER 均识别', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    const plain = generateApiKey()
    apiKeyStore.insert({
      name: 'case',
      keyHash: hashApiKey(plain),
      keyPrefix: extractKeyPrefix(plain),
      expiresAt: 0,
    })
    const r1 = await request(app).get('/v1/models').set('Authorization', `bearer ${plain}`)
    expect(r1.status).toBe(200)
    const r2 = await request(app).get('/v1/models').set('Authorization', `BEARER ${plain}`)
    expect(r2.status).toBe(200)
  })

  it('管理端 /admin/api/* 无需 Key，即使开关开启也可访问', async () => {
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    // 无 token 直接请求 /admin/api/auth/status → 200（管理端由部署层防护）
    const res = await request(app).get('/admin/api/auth/status')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
  })
})

describe('管理端 API Key CRUD /admin/api/keys', () => {
  it('GET 空列表返回 { rows: [], total: 0 }', async () => {
    const res = await request(app).get('/admin/api/keys')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ rows: [], total: 0 })
  })

  it('POST 创建：name 必填；apiKey 明文返回一次；list 中不含明文', async () => {
    const res = await request(app).post('/admin/api/keys').send({ name: 'svc-a' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeGreaterThan(0)
    expect(res.body.name).toBe('svc-a')
    expect(res.body.apiKey).toMatch(/^sk-llmproxy-/)
    expect(res.body.keyPrefix).toBe(res.body.apiKey.slice(0, 8))
    expect(res.body.expiresAt).toBe(0)
    expect(res.body.disabled).toBe(0)

    // 列表不返回 apiKey / keyHash（仅 keyPrefix）
    const list = await request(app).get('/admin/api/keys')
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(1)
    expect(list.body.rows[0]).not.toHaveProperty('apiKey')
    expect(list.body.rows[0]).not.toHaveProperty('keyHash')
    expect(list.body.rows[0].keyPrefix).toBe(res.body.keyPrefix)
  })

  it('POST 创建：name 缺省或空 → 400', async () => {
    const res = await request(app).post('/admin/api/keys').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('POST 创建：expiresAt 必须 > now 或 0（已过去的时间 → 400）', async () => {
    const res = await request(app)
      .post('/admin/api/keys')
      .send({ name: 'svc', expiresAt: Date.now() - 1000 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_expires_at')
  })

  it('GET 分页：offset/limit 正确；keyword 模糊匹配；includeDisabled=true 包含停用', async () => {
    // 插入 3 条
    for (const n of ['alpha', 'beta', 'gamma']) {
      await request(app).post('/admin/api/keys').send({ name: n })
    }
    // 停用 alpha
    const all = await request(app).get('/admin/api/keys?includeDisabled=true&limit=10')
    const alphaId = all.body.rows.find((r: { name: string }) => r.name === 'alpha').id
    await request(app).put(`/admin/api/keys/${alphaId}`).send({ disabled: true })

    // 默认不含 disabled → 2 条
    const onlyActive = await request(app).get('/admin/api/keys')
    expect(onlyActive.body.total).toBe(2)

    // includeDisabled=true → 3 条
    const allRows = await request(app).get('/admin/api/keys?includeDisabled=true')
    expect(allRows.body.total).toBe(3)

    // keyword 模糊匹配
    const byKw = await request(app).get('/admin/api/keys?keyword=bet')
    expect(byKw.body.total).toBe(1)
    expect(byKw.body.rows[0].name).toBe('beta')

    // 分页：limit=1 offset=1
    const page = await request(app).get('/admin/api/keys?limit=1&offset=1')
    expect(page.body.rows).toHaveLength(1)
    expect(page.body.total).toBe(2)
  })

  it('PUT 更新：name / expiresAt / disabled 单字段修改；不存在返回 404', async () => {
    const created = await request(app).post('/admin/api/keys').send({ name: 'old' })
    const id = created.body.id

    // 改 name
    const r1 = await request(app).put(`/admin/api/keys/${id}`).send({ name: 'new' })
    expect(r1.status).toBe(200)
    expect(r1.body.name).toBe('new')

    // 改 disabled
    const r2 = await request(app).put(`/admin/api/keys/${id}`).send({ disabled: true })
    expect(r2.status).toBe(200)
    expect(r2.body.disabled).toBe(1)

    // 不存在
    const r3 = await request(app).put('/admin/api/keys/99999').send({ name: 'x' })
    expect(r3.status).toBe(404)
    expect(r3.body.error).toBe('api_key_not_found')

    // 非法 id
    const r4 = await request(app).put('/admin/api/keys/abc').send({ name: 'x' })
    expect(r4.status).toBe(400)
    expect(r4.body.error).toBe('invalid_id')
  })

  it('DELETE 删除：返回 deleted；幂等（重复删除 deleted=false）', async () => {
    const created = await request(app).post('/admin/api/keys').send({ name: 'k' })
    const id = created.body.id

    const r1 = await request(app).delete(`/admin/api/keys/${id}`)
    expect(r1.status).toBe(200)
    expect(r1.body.deleted).toBe(true)

    const r2 = await request(app).delete(`/admin/api/keys/${id}`)
    expect(r2.status).toBe(200)
    expect(r2.body.deleted).toBe(false)

    // 非法 id
    const r3 = await request(app).delete('/admin/api/keys/abc')
    expect(r3.status).toBe(400)
  })

  it('GET /admin/api/auth/status 返回 enabled + total', async () => {
    // 初始：未开启、total=0
    let s = await request(app).get('/admin/api/auth/status')
    expect(s.body).toEqual({ enabled: false, total: 0 })

    // 创建 1 条
    await request(app).post('/admin/api/keys').send({ name: 'one' })
    s = await request(app).get('/admin/api/auth/status')
    expect(s.body.total).toBe(1)
    expect(s.body.enabled).toBe(false)

    // 开启 auth
    store.set({ ...BASE_CONFIG, auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } }, { source: 'admin' })
    s = await request(app).get('/admin/api/auth/status')
    expect(s.body.enabled).toBe(true)
    expect(s.body.total).toBe(1)
  })
})
// 管理员账号 CRUD 端点测试（需登录）：supertest + 真实 ConfigStore / AdminSessionStore（临时目录）
// 覆盖：list 无密码回显（hasPassword 标记）、create 成功/重名/空参、update 停用/改密/空 body/未知/空密码保持、
//       delete 成功/删自己/删最后启用/未知，以及全部受保护端点的 401 未登录
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import type { Config } from '../../src/config/schema.js'
import { LogStore } from '../../src/logstore/index.js'
import { SessionStore } from '../../src/session/db.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { AdminSessionStore } from '../../src/auth/session-store.js'
import { ADMIN_SESSION_COOKIE, computePasswordHash } from '../../src/auth/admin-auth.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { registerAdminRoutes } from '../../src/server/admin.js'

// 固定 salt 与两个初始账号：admin / alice（均启用）
const ADMIN_SALT =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const ADMIN_PASSWORD = 'admin-pass-123'
const ALICE_PASSWORD = 'alice-pass-123'

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
  admins: {
    salt: ADMIN_SALT,
    accounts: [
      {
        username: 'admin',
        password: ADMIN_PASSWORD,
        disabled: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
      },
      {
        username: 'alice',
        password: ALICE_PASSWORD,
        disabled: false,
        createdAt: '2026-01-02T00:00:00.000Z',
        lastLoginAt: null,
      },
    ],
  },
}

let tmpDir: string
let cfgPath: string
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let logStore: LogStore
let apiKeyStore: ApiKeyStore
let adminSessionStore: AdminSessionStore
let app: Express

function buildApp(): void {
  app = express()
  app.use(express.json())
  registerAdminRoutes(app, {
    store,
    getUpstreamClient: () => undefined,
    stats,
    sessionStore,
    logStore,
    apiKeyStore,
    adminSessionStore,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-admins-'))
  cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  sessionStore = new SessionStore(join(tmpDir, 'sessions.db'))
  logStore = new LogStore(join(tmpDir, 'logs.db'))
  apiKeyStore = new ApiKeyStore(join(tmpDir, 'apikeys.db'))
  adminSessionStore = new AdminSessionStore(join(tmpDir, 'admin-sessions.db'))
  buildApp()
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const close of [
    sessionStore.close,
    logStore.close,
    apiKeyStore.close,
    adminSessionStore.close,
  ]) {
    try {
      close()
    } catch {
      // 连接已关闭，无需处理
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

// supertest 将 set-cookie 头类型标为 string，但运行时实为 string[]（Node IncomingHttpHeaders）；统一归一为 string[]
const getSetCookieList = (res: { headers: Record<string, string | string[] | undefined> }): string[] => {
  const raw = res.headers['set-cookie']
  if (raw === undefined) {
    return []
  }
  return Array.isArray(raw) ? raw : [raw]
}

// 完整登录链路，返回会话 Cookie 串（失败返回 undefined）
async function loginCookie(username: string, password: string): Promise<string | undefined> {
  const saltRes = await request(app).get('/admin/api/auth/salt')
  const salt = saltRes.body.salt as string
  const ts = saltRes.body.ts as number
  const res = await request(app)
    .post('/admin/api/auth/login')
    .send({ username, passwordMd5: computePasswordHash(salt, ts, password), ts })
  if (res.status !== 200) {
    return undefined
  }
  const setCookies = getSetCookieList(res)
  const sc = setCookies.find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE}=`))
  if (sc === undefined) {
    return undefined
  }
  return sc.split(';')[0]
}

describe('GET /admin/api/admins', () => {
  it('无会话 → 401 unauthenticated', async () => {
    const res = await request(app).get('/admin/api/admins')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('持会话 → 返回列表，绝不含明文密码，仅 hasPassword 标记', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app).get('/admin/api/admins').set('Cookie', cookie as string)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(2)
    for (const item of res.body as Array<Record<string, unknown>>) {
      // 任一字段都不得出现明文密码
      expect(JSON.stringify(item)).not.toContain(ADMIN_PASSWORD)
      expect(JSON.stringify(item)).not.toContain(ALICE_PASSWORD)
      expect('password' in item).toBe(false)
      expect(typeof item.hasPassword).toBe('boolean')
      expect(item.hasPassword).toBe(true)
      expect(typeof item.username).toBe('string')
      expect(typeof item.disabled).toBe('boolean')
      expect(typeof item.createdAt).toBe('string')
    }
    const admin = (res.body as Array<{ username: string; lastLoginAt: string | null }>).find((a) => a.username === 'admin')
    expect(admin?.lastLoginAt).toBeTruthy()
  })
})

describe('POST /admin/api/admins', () => {
  it('无会话 → 401 unauthenticated', async () => {
    const res = await request(app)
      .post('/admin/api/admins')
      .send({ username: 'bob', password: 'bob-pass-123' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('持会话，合法账号 → 201 创建成功，新账号可登录、出现在列表', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .post('/admin/api/admins')
      .set('Cookie', cookie as string)
      .send({ username: 'bob', password: 'bob-pass-123' })
    expect(res.status).toBe(201)
    expect(res.body.username).toBe('bob')
    expect(res.body.hasPassword).toBe(true)
    expect('password' in res.body).toBe(false)
    // 新账号能用其密码登录
    expect(await loginCookie('bob', 'bob-pass-123')).toBeDefined()
    // 列表里出现 bob
    const list = await request(app).get('/admin/api/admins').set('Cookie', cookie as string)
    expect(list.body).toHaveLength(3)
    expect(list.body.some((a: { username: string }) => a.username === 'bob')).toBe(true)
  })

  it('重名账号 → 400 duplicate_username', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .post('/admin/api/admins')
      .set('Cookie', cookie as string)
      .send({ username: 'alice', password: 'another-pass' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('duplicate_username')
  })

  it('username / password 任一为空 → 400 invalid_admin', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const r1 = await request(app)
      .post('/admin/api/admins')
      .set('Cookie', cookie as string)
      .send({ username: '', password: 'some-pass' })
    expect(r1.status).toBe(400)
    expect(r1.body.error).toBe('invalid_admin')
    const r2 = await request(app)
      .post('/admin/api/admins')
      .set('Cookie', cookie as string)
      .send({ username: 'bob', password: '' })
    expect(r2.status).toBe(400)
    expect(r2.body.error).toBe('invalid_admin')
  })
})

describe('PATCH /admin/api/admins/:username', () => {
  it('无会话 → 401 unauthenticated', async () => {
    const res = await request(app)
      .patch('/admin/api/admins/alice')
      .send({ disabled: true })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('停用账号 → 200 且该账号无法再登录', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .patch('/admin/api/admins/alice')
      .set('Cookie', cookie as string)
      .send({ disabled: true })
    expect(res.status).toBe(200)
    expect(res.body.username).toBe('alice')
    expect(res.body.disabled).toBe(true)
    // 停用后登录被拒
    expect(await loginCookie('alice', ALICE_PASSWORD)).toBeUndefined()
  })

  it('修改密码 → 200 且新密码生效、旧密码失效', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .patch('/admin/api/admins/alice')
      .set('Cookie', cookie as string)
      .send({ password: 'new-alice-pass' })
    expect(res.status).toBe(200)
    expect(res.body.username).toBe('alice')
    expect(await loginCookie('alice', 'new-alice-pass')).toBeDefined()
    expect(await loginCookie('alice', ALICE_PASSWORD)).toBeUndefined()
  })

  it('空 password（空串）= 保持原值，原密码仍可用', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .patch('/admin/api/admins/alice')
      .set('Cookie', cookie as string)
      .send({ password: '' })
    expect(res.status).toBe(200)
    // 原密码仍可登录（未被清空）
    expect(await loginCookie('alice', ALICE_PASSWORD)).toBeDefined()
  })

  it('空 body（无 password 也无 disabled）→ 400 invalid_admin', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .patch('/admin/api/admins/alice')
      .set('Cookie', cookie as string)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_admin')
  })

  it('未知账号 → 404 admin_not_found', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .patch('/admin/api/admins/ghost')
      .set('Cookie', cookie as string)
      .send({ disabled: true })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('admin_not_found')
  })
})

describe('DELETE /admin/api/admins/:username', () => {
  it('无会话 → 401 unauthenticated', async () => {
    const res = await request(app).delete('/admin/api/admins/alice')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('删除他人（启用中，仍有其它启用账号）→ 200 且账号消失', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .delete('/admin/api/admins/alice')
      .set('Cookie', cookie as string)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    const list = await request(app).get('/admin/api/admins').set('Cookie', cookie as string)
    expect(list.body).toHaveLength(1)
    expect(list.body.some((a: { username: string }) => a.username === 'alice')).toBe(false)
  })

  it('删除自己 → 400 cannot_delete_self（优先于 last_admin 判定）', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .delete('/admin/api/admins/admin')
      .set('Cookie', cookie as string)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cannot_delete_self')
  })

  it('删除最后一个启用中的账号 → 400 last_admin', async () => {
    const cookieAdmin = await loginCookie('admin', ADMIN_PASSWORD)
    const cookieAlice = await loginCookie('alice', ALICE_PASSWORD)
    expect(cookieAdmin).toBeDefined()
    expect(cookieAlice).toBeDefined()
    // admin 先停用 alice → 仅剩 admin 一个启用账号
    const disable = await request(app)
      .patch('/admin/api/admins/alice')
      .set('Cookie', cookieAdmin as string)
      .send({ disabled: true })
    expect(disable.status).toBe(200)
    // 以 alice（既有会话仍有效）删除唯一的启用账号 admin → last_admin
    const res = await request(app)
      .delete('/admin/api/admins/admin')
      .set('Cookie', cookieAlice as string)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('last_admin')
  })

  it('未知账号 → 404 admin_not_found', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app)
      .delete('/admin/api/admins/ghost')
      .set('Cookie', cookie as string)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('admin_not_found')
  })
})

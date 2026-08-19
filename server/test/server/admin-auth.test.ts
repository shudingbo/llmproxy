// 管理端登录与账号会话端点测试：supertest + 真实 ConfigStore / AdminSessionStore（临时目录）
// 覆盖：salt 下发、status 登录态、login 成功/失败（密码错/用户不存在/停用同形 401、ts 超窗、缺参 400）、
//       logout 幂等与失效、change-password 成功/旧密码错/未登录
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

// 固定的管理员 salt（64 字符 hex，与生产 generateDefaultAdmins 同形）与两个初始账号
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
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-auth-'))
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

// 从 Set-Cookie 头提取管理端会话 id（HttpOnly，前端 JS 读不到，测试直接取原始头）
function extractSessionId(setCookies: string[] | undefined): string | undefined {
  if (!setCookies) {
    return undefined
  }
  for (const c of setCookies) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx === -1) {
      continue
    }
    if (pair.slice(0, idx).trim() === ADMIN_SESSION_COOKIE) {
      return pair.slice(idx + 1).trim()
    }
  }
  return undefined
}

// 完整登录链路：取 salt/ts → 计算 MD5(salt+ts+password) → POST /auth/login；返回会话 Cookie 串（失败返回 undefined）
async function loginCookie(username: string, password: string, tsOverride?: number): Promise<string | undefined> {
  const saltRes = await request(app).get('/admin/api/auth/salt')
  const salt = saltRes.body.salt as string
  const ts = tsOverride ?? (saltRes.body.ts as number)
  const res = await request(app)
    .post('/admin/api/auth/login')
    .send({ username, passwordMd5: computePasswordHash(salt, ts, password), ts })
  if (res.status !== 200) {
    return undefined
  }
  const sessionId = extractSessionId(getSetCookieList(res))
  return sessionId === undefined ? undefined : `${ADMIN_SESSION_COOKIE}=${sessionId}`
}

describe('GET /admin/api/auth/salt', () => {
  it('返回配置的 salt + 当前 epoch 秒（前端据此计算 MD5 摘要）', async () => {
    const before = Math.floor(Date.now() / 1000)
    const res = await request(app).get('/admin/api/auth/salt')
    const after = Math.floor(Date.now() / 1000)
    expect(res.status).toBe(200)
    expect(res.body.salt).toBe(ADMIN_SALT)
    expect(Number.isInteger(res.body.ts)).toBe(true)
    expect(res.body.ts).toBeGreaterThanOrEqual(before)
    expect(res.body.ts).toBeLessThanOrEqual(after)
  })
})

describe('GET /admin/api/auth/status', () => {
  it('无会话 → authenticated=false、username=null（API Key 状态字段仍在）', async () => {
    const res = await request(app).get('/admin/api/auth/status')
    expect(res.status).toBe(200)
    expect(res.body.authenticated).toBe(false)
    expect(res.body.username).toBeNull()
    expect(typeof res.body.enabled).toBe('boolean')
    expect(typeof res.body.total).toBe('number')
  })

  it('持有效会话 Cookie → authenticated=true 且 username 为登录账号', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const res = await request(app).get('/admin/api/auth/status').set('Cookie', cookie as string)
    expect(res.status).toBe(200)
    expect(res.body.authenticated).toBe(true)
    expect(res.body.username).toBe('admin')
  })

  it('伪造/无效会话 Cookie → authenticated=false（不泄露具体原因）', async () => {
    const res = await request(app)
      .get('/admin/api/auth/status')
      .set('Cookie', `${ADMIN_SESSION_COOKIE}=deadbeefdeadbeef`)
    expect(res.status).toBe(200)
    expect(res.body.authenticated).toBe(false)
    expect(res.body.username).toBeNull()
  })
})

describe('POST /admin/api/auth/login', () => {
  it('正确凭据 → 200 + 种 HttpOnly 会话 Cookie + 刷新 lastLoginAt', async () => {
    const res = await request(app)
      .post('/admin/api/auth/login')
      .send({
        username: 'admin',
        passwordMd5: computePasswordHash(ADMIN_SALT, Math.floor(Date.now() / 1000), ADMIN_PASSWORD),
        ts: Math.floor(Date.now() / 1000),
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.username).toBe('admin')
    // Set-Cookie 携带会话 id，且为 HttpOnly（防前端脚本读取）
    const setCookies = getSetCookieList(res)
    const sc = setCookies.find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    expect(sc).toBeDefined()
    expect(sc).toMatch(/HttpOnly/i)
    // lastLoginAt 从 null 被刷新为 ISO 时间戳
    const account = store.get().admins?.accounts.find((a) => a.username === 'admin')
    expect(account?.lastLoginAt).toBeTruthy()
  })

  it('密码错误 → 401 invalid_credentials（与用户不存在同形，防枚举）', async () => {
    const res = await request(app)
      .post('/admin/api/auth/login')
      .send({
        username: 'admin',
        passwordMd5: computePasswordHash(ADMIN_SALT, Math.floor(Date.now() / 1000), 'wrong-password'),
        ts: Math.floor(Date.now() / 1000),
      })
    expect(res.status).toBe(401)
    expect(res.body.status).toBe(false)
    expect(res.body.error).toBe('invalid_credentials')
  })

  it('用户不存在 → 401 invalid_credentials（与密码错完全同形）', async () => {
    const res = await request(app)
      .post('/admin/api/auth/login')
      .send({
        username: 'ghost',
        passwordMd5: computePasswordHash(ADMIN_SALT, Math.floor(Date.now() / 1000), 'whatever'),
        ts: Math.floor(Date.now() / 1000),
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_credentials')
    // 与「密码错」场景的响应体结构完全一致（仅 status/msg/error 三键）
    expect(Object.keys(res.body).sort()).toEqual(['error', 'msg', 'status'])
  })

  it('已停用账号 → 401 invalid_credentials（即便密码正确）', async () => {
    // 停用 alice 后登录应被拒
    store.set(
      {
        ...store.get(),
        admins: {
          ...store.get().admins as NonNullable<Config['admins']>,
          accounts: (store.get().admins?.accounts ?? []).map((a) =>
            a.username === 'alice' ? { ...a, disabled: true } : a,
          ),
        },
      },
      { source: 'admin' },
    )
    const cookie = await loginCookie('alice', ALICE_PASSWORD)
    expect(cookie).toBeUndefined()
    const res = await request(app)
      .post('/admin/api/auth/login')
      .send({
        username: 'alice',
        passwordMd5: computePasswordHash(ADMIN_SALT, Math.floor(Date.now() / 1000), ALICE_PASSWORD),
        ts: Math.floor(Date.now() / 1000),
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_credentials')
  })

  it('ts 超出 ±60s 窗口 → 401 timestamp_expired（防重放）', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 3600
    const res = await request(app)
      .post('/admin/api/auth/login')
      .send({
        username: 'admin',
        passwordMd5: computePasswordHash(ADMIN_SALT, staleTs, ADMIN_PASSWORD),
        ts: staleTs,
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('timestamp_expired')
  })

  it('缺 username / passwordMd5 → 400 invalid_login', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const r1 = await request(app).post('/admin/api/auth/login').send({ passwordMd5: 'x', ts })
    expect(r1.status).toBe(400)
    expect(r1.body.error).toBe('invalid_login')
    const r2 = await request(app)
      .post('/admin/api/auth/login')
      .send({ username: 'admin', ts })
    expect(r2.status).toBe(400)
    expect(r2.body.error).toBe('invalid_login')
  })
})

describe('POST /admin/api/auth/logout', () => {
  it('有效会话 → 200 且会话失效（后续受保护端点 401）', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    // 登出前：/admins 可访问
    const before = await request(app).get('/admin/api/admins').set('Cookie', cookie as string)
    expect(before.status).toBe(200)
    // 登出
    const res = await request(app).post('/admin/api/auth/logout').set('Cookie', cookie as string)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    // 登出后：同一 Cookie 失效
    const after = await request(app).get('/admin/api/admins').set('Cookie', cookie as string)
    expect(after.status).toBe(401)
    expect(after.body.error).toBe('unauthenticated')
  })

  it('无会话 → 幂等 200（不报错）', async () => {
    const res = await request(app).post('/admin/api/auth/logout')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
  })
})

describe('POST /admin/api/auth/change-password', () => {
  it('未登录（无会话）→ 401 unauthenticated', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const res = await request(app)
      .post('/admin/api/auth/change-password')
      .send({
        oldPasswordMd5: computePasswordHash(ADMIN_SALT, ts, ADMIN_PASSWORD),
        newPassword: 'new-pass-456',
        ts,
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })

  it('旧密码正确 → 200 且新密码生效、旧密码失效', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const ts = Math.floor(Date.now() / 1000)
    const res = await request(app)
      .post('/admin/api/auth/change-password')
      .set('Cookie', cookie as string)
      .send({
        oldPasswordMd5: computePasswordHash(ADMIN_SALT, ts, ADMIN_PASSWORD),
        newPassword: 'new-pass-456',
        ts,
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    // 配置中明文已更新
    const account = store.get().admins?.accounts.find((a) => a.username === 'admin')
    expect(account?.password).toBe('new-pass-456')
    // 新密码可登录，旧密码不可
    expect(await loginCookie('admin', 'new-pass-456')).toBeDefined()
    expect(await loginCookie('admin', ADMIN_PASSWORD)).toBeUndefined()
  })

  it('旧密码错误 → 400 wrong_old_password，密码不变', async () => {
    const cookie = await loginCookie('admin', ADMIN_PASSWORD)
    expect(cookie).toBeDefined()
    const ts = Math.floor(Date.now() / 1000)
    const res = await request(app)
      .post('/admin/api/auth/change-password')
      .set('Cookie', cookie as string)
      .send({
        oldPasswordMd5: computePasswordHash(ADMIN_SALT, ts, 'not-the-old-password'),
        newPassword: 'new-pass-456',
        ts,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('wrong_old_password')
    // 密码保持原值
    const account = store.get().admins?.accounts.find((a) => a.username === 'admin')
    expect(account?.password).toBe(ADMIN_PASSWORD)
  })
})

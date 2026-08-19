// 管理端全局登录鉴权保护测试：白名单外的所有 /admin/api/* 端点一律要求登录会话
// 覆盖：
//   - 非白名单端点「无会话」→ 401（统一形状 error=unauthenticated，防枚举）
//   - 非白名单端点「持有效会话」→ 非 401（通过鉴权门进入 handler，可能为 200/400/404）
//   - 白名单端点（health / auth/salt / auth/status / auth/logout）→ 免登录可访问
//   - 完整登录链路（salt → MD5(salt+ts+password) → 200 + 会话 Cookie；错误密码 → 401 invalid_credentials）
//   - 伪造会话 Cookie → 401（与缺失同形）
// 说明：上游地址不可达（127.0.0.1:1），本文件只验证「鉴权门」而非 handler 业务行为，
//       故「持会话」断言统一为 status !== 401（放行即视为通过鉴权门）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { LogStore } from '../../src/logstore/index.js'
import { SessionStore } from '../../src/session/db.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { AdminSessionStore } from '../../src/auth/session-store.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { registerAdminRoutes } from '../../src/server/admin.js'
import { adminRequest } from '../helpers/adminSession.js'
import { ADMIN_SESSION_COOKIE, computePasswordHash } from '../../src/auth/admin-auth.js'

// 基础配置：单上游 + 单别名；timeoutMs 压低以便 handler 内网络探测快速失败（本文件不断言其业务结果）
const BASE_CONFIG = {
  upstreams: [
    { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', timeoutMs: 2000, disabled: false, responsesApi: 'convert' },
  ],
  downstreamModels: {
    'gpt-4': { disabled: false, candidates: [{ upstreamId: 'u1', model: 'gpt-4' }] },
  },
}

// 非白名单端点目录（与 admin.ts 中 app.*('/admin/api/...') 一一对应；路径参数取具体值）
type Method = 'get' | 'post' | 'put' | 'delete' | 'patch'
const PROTECTED: Array<{ method: Method; path: string }> = [
  { method: 'get', path: '/admin/api/upstreams' },
  { method: 'post', path: '/admin/api/upstreams' },
  { method: 'put', path: '/admin/api/upstreams/u1' },
  { method: 'delete', path: '/admin/api/upstreams/u1' },
  { method: 'post', path: '/admin/api/upstreams/u1/test' },
  { method: 'post', path: '/admin/api/upstreams/u1/detect-responses' },
  { method: 'post', path: '/admin/api/candidates/probe-context' },
  { method: 'get', path: '/admin/api/downstream-models' },
  { method: 'put', path: '/admin/api/downstream-models' },
  { method: 'get', path: '/admin/api/logs' },
  { method: 'post', path: '/admin/api/logs/cleanup' },
  { method: 'get', path: '/admin/api/stats' },
  { method: 'get', path: '/admin/api/sessions' },
  { method: 'get', path: '/admin/api/session-clients' },
  { method: 'delete', path: '/admin/api/sessions/demo-key' },
  { method: 'delete', path: '/admin/api/sessions' },
  { method: 'post', path: '/admin/api/sessions/cleanup' },
  { method: 'get', path: '/admin/api/keys' },
  { method: 'post', path: '/admin/api/keys' },
  { method: 'put', path: '/admin/api/keys/1' },
  { method: 'delete', path: '/admin/api/keys/1' },
  { method: 'post', path: '/admin/api/auth/change-password' },
  { method: 'get', path: '/admin/api/admins' },
  { method: 'post', path: '/admin/api/admins' },
  { method: 'patch', path: '/admin/api/admins/alice' },
  { method: 'delete', path: '/admin/api/admins/alice' },
  { method: 'get', path: '/admin/api/config' },
  { method: 'put', path: '/admin/api/config' },
  { method: 'get', path: '/admin/api/config/reload-error' },
]

// 白名单端点目录：免登录可访问（login 单独在登录链路用例中验证，因其业务 401 与鉴权 401 同码）
const PUBLIC: Array<{ method: Method; path: string; expectStatus: number }> = [
  { method: 'get', path: '/admin/api/health', expectStatus: 200 },
  { method: 'get', path: '/admin/api/auth/salt', expectStatus: 200 },
  { method: 'get', path: '/admin/api/auth/status', expectStatus: 200 },
  { method: 'post', path: '/admin/api/auth/logout', expectStatus: 200 },
]

let tmpDir = ''
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let logStore: LogStore
let apiKeyStore: ApiKeyStore
let adminSessionStore: AdminSessionStore
let app: Express
// 带有效管理会话 Cookie 的请求工厂（默认「已登录」身份）
let req: ReturnType<typeof adminRequest>

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
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-protection-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  sessionStore = new SessionStore(join(tmpDir, 'sessions.db'))
  logStore = new LogStore(join(tmpDir, 'logs.db'))
  apiKeyStore = new ApiKeyStore(join(tmpDir, 'apikeys.db'))
  adminSessionStore = new AdminSessionStore(join(tmpDir, 'admin-sessions.db'))
  // Windows 读 USERPROFILE，POSIX 读 HOME：两个都 stub 才跨平台生效（日志目录落临时区）
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
  buildApp()
  req = adminRequest(app, adminSessionStore)
})

afterEach(() => {
  vi.unstubAllEnvs()
  try { sessionStore.close() } catch {}
  try { logStore.close() } catch {}
  try { apiKeyStore.close() } catch {}
  try { adminSessionStore.close() } catch {}
  rmSync(tmpDir, { recursive: true, force: true })
})

// 统一调用入口：supertest 动词方法返回 thenable，await 得响应
type Res = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> }
interface VerbObj {
  get: (p: string) => unknown
  post: (p: string) => unknown
  put: (p: string) => unknown
  delete: (p: string) => unknown
  patch: (p: string) => unknown
}
async function call(t: VerbObj, method: Method, path: string): Promise<Res> {
  return (await t[method](path)) as Res
}

describe('非白名单端点 · 无会话 → 401（统一形状 unauthenticated）', () => {
  for (const { method, path } of PROTECTED) {
    it(`${method.toUpperCase()} ${path}`, async () => {
      const res = await call(request(app), method, path)
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('unauthenticated')
    })
  }
})

describe('非白名单端点 · 持有效会话 → 非 401（通过鉴权门）', () => {
  for (const { method, path } of PROTECTED) {
    it(`${method.toUpperCase()} ${path}`, async () => {
      const res = await call(req(), method, path)
      expect(res.status).not.toBe(401)
    })
  }
})

describe('白名单端点 · 免登录可访问', () => {
  for (const { method, path, expectStatus } of PUBLIC) {
    it(`${method.toUpperCase()} ${path} → ${expectStatus}`, async () => {
      const res = await call(request(app), method, path)
      expect(res.status).toBe(expectStatus)
    })
  }
})

describe('完整登录链路', () => {
  // 注入一个已知明文密码的管理员账号（salt 64 位 hex）
  function seedAdmins(): void {
    store.set(
      { ...BASE_CONFIG, admins: { salt: 'ab'.repeat(32), accounts: [{ username: 'admin', password: 'secret' }] } },
      { source: 'admin' },
    )
  }

  async function loginWith(password: string): Promise<Res> {
    const saltRes = await call(request(app), 'get', '/admin/api/auth/salt')
    const salt = saltRes.body.salt as string
    const ts = saltRes.body.ts as number
    const passwordMd5 = computePasswordHash(salt, ts, password)
    return (await request(app).post('/admin/api/auth/login').send({ username: 'admin', passwordMd5, ts })) as unknown as Res
  }

  it('正确凭据 → 200 + 种会话 Cookie', async () => {
    seedAdmins()
    const res = await loginWith('secret')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.headers['set-cookie']).toBeDefined()
  })

  it('错误密码 → 401 invalid_credentials（与「用户不存在」同形，防枚举）', async () => {
    seedAdmins()
    const res = await loginWith('wrong-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_credentials')
  })
})

describe('伪造会话', () => {
  it('无效会话 Cookie → 401 unauthenticated（与缺失同形）', async () => {
    const res = (await request(app).get('/admin/api/upstreams').set('Cookie', `${ADMIN_SESSION_COOKIE}=deadbeefdeadbeef`)) as unknown as Res
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthenticated')
  })
})

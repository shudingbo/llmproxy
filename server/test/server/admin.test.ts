// 管理端 REST 接口测试：supertest + 真实 ConfigStore（临时目录）+ 可注入假客户端
// 覆盖：上游 CRUD 与密钥掩码、级联删除、最后一个上游保护、连通性测试（覆盖/配置两种模式、各类错误代号）、
//       上下文探测（新增/编辑模式、缺参 400、探测不到、网络错误、防御分支错误代号）、
//       下游模型映射整体替换、日志 SQLite 查询（倒序/级别/关键词过滤/offset 翻页/limit/hasMore/日期过滤）、统计汇总、健康检查、配置掩码与重载错误
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { LogStore, type LogEntry } from '../../src/logstore/index.js'
import { SessionStore, type SessionBindInfo } from '../../src/session/db.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { probeMaxContext } from '../../src/upstream/context.js'
import type { OpenAIUpstreamClient } from '../../src/upstream/openai.js'
import { registerAdminRoutes } from '../../src/server/admin.js'

// probeMaxContext 包一层可替换的 mock：默认透传真实实现（其余用例不受影响），
// 仅「防御分支」用例改为抛错，验证端点 try/catch → extractErrorCode 的错误代号回退
vi.mock('../../src/upstream/context.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/upstream/context.js')>()
  return { ...original, probeMaxContext: vi.fn(original.probeMaxContext) }
})

// 基础配置模板：u1 健康 / u2 暂停；gpt-4 别名引用两者，only-u2 别名仅引用 u2（用于级联删除断言）
const BASE_CONFIG = {
  upstreams: [
    { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-long-1234', timeoutMs: 5000, disabled: false },
    { id: 'u2', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'abcd', timeoutMs: 5000, disabled: true },
  ],
  downstreamModels: {
    'gpt-4': [
      { upstreamId: 'u1', model: 'gpt-4-u1' },
      { upstreamId: 'u2', model: 'gpt-4-u2' },
    ],
    'only-u2': [{ upstreamId: 'u2', model: 'x' }],
  },
}

// 模拟上游服务器处理器类型
type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

// 已启动的模拟上游服务器（afterEach 统一关闭）
const servers: Server[] = []

// 启动一个模拟上游，返回 baseUrl（形如 http://127.0.0.1:PORT/v1）
async function startMock(handler: MockHandler): Promise<string> {
  const srv = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      if (!res.destroyed) {
        res.statusCode = 500
        res.end(String(err))
      }
    })
  })
  servers.push(srv)
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

// 构造一个仅实现 listModels 的假客户端（其余方法不会被调用）
function fakeClient(listModels: () => Promise<Array<{ id: string }>>): OpenAIUpstreamClient {
  return { listModels } as unknown as OpenAIUpstreamClient
}

// 带 code 属性的错误（模拟 ECONNREFUSED 等 Node 网络错误）
const errWithCode = (code: string): Error => Object.assign(new Error(code), { code })
// 带 status 属性的错误（模拟 HTTP 错误）
const errWithStatus = (status: number): Error => Object.assign(new Error(String(status)), { status })

// 直接用 SQL 改写某条记录的 updated_at（模拟时间流逝；SessionStore 不暴露裸 SQL）
const setSessionUpdatedAt = (dbPath: string, sessionKey: string, updatedAt: number): void => {
  const db = new Database(dbPath)
  try {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?').run(updatedAt, sessionKey)
  } finally {
    db.close()
  }
}

// 构造默认 bind 入参（可覆盖部分字段）
const makeSessionInfo = (over: Partial<SessionBindInfo> = {}): SessionBindInfo => ({
  sessionId: 'chat-uuid-1',
  client: 'open-webui',
  downstreamModel: 'gpt-4o',
  upstreamId: 'up-1',
  upstreamModel: 'gpt-4o-azure',
  ...over,
})

// 每次测试的共享状态
let tmpDir = ''
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let sessionDbPath: string
let logStore: LogStore
let logDbPath: string
let app: Express
let clients: Map<string, OpenAIUpstreamClient>

// 构造被测应用：express.json（装配层职责）+ 管理端路由；cli 透传命令行参数（默认 undefined）
function buildApp(cli?: { host?: string; port?: number }): void {
  app = express()
  app.use(express.json())
  registerAdminRoutes(app, {
    store,
    getUpstreamClient: (id) => clients.get(id),
    stats,
    sessionStore,
    logStore,
    cli,
  })
}

beforeEach(() => {
  // 每个用例独立的临时配置目录；同时把日志目录（homedir/llmproxy/logs）重定向到临时目录
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  // 会话粘附存储：真实 SessionStore + 临时 DB 文件（WAL 伴生文件随 tmpDir 一并删除）
  sessionDbPath = join(tmpDir, 'sessions.db')
  sessionStore = new SessionStore(sessionDbPath)
  // 日志存储：真实 LogStore + 临时 DB 文件（独立文件，避免与 sessions 表互相干扰）
  logDbPath = join(tmpDir, 'logs.db')
  logStore = new LogStore(logDbPath)
  clients = new Map()
  buildApp()
  // Windows 读 USERPROFILE，POSIX 读 HOME：两个都 stub 才跨平台生效
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  // 先关会话库再删目录：WAL 模式下文件句柄保持打开，先关连接避免删除竞态
  try {
    sessionStore.close()
  } catch {
    // 连接已关闭，无需处理
  }
  try {
    logStore.close()
  } catch {
    // 连接已关闭，无需处理
  }
  for (const srv of servers) {
    if (srv.listening) {
      srv.closeAllConnections()
    }
  }
  for (const srv of servers) {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  servers.length = 0
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('上游管理 /admin/api/upstreams', () => {
  it('GET 返回列表且 apiKey 全部掩码（长密钥 3 星 + 后 4 位，短密钥全星）', async () => {
    const res = await request(app).get('/admin/api/upstreams')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '***1234', timeoutMs: 5000, disabled: false },
      { id: 'u2', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '****', timeoutMs: 5000, disabled: true },
    ])
  })

  it('POST 新增上游：zod 补齐缺省字段，返回 201 且密钥掩码', async () => {
    const res = await request(app)
      .post('/admin/api/upstreams')
      .send({ id: 'u3', baseUrl: 'https://example.com/v1', apiKey: 'key12345' })
    expect(res.status).toBe(201)
    // timeoutMs / disabled 由 schema 默认补齐
    expect(res.body).toEqual({
      id: 'u3',
      baseUrl: 'https://example.com/v1',
      apiKey: '***2345',
      timeoutMs: 30000,
      disabled: false,
    })
    const config = store.get()
    expect(config.upstreams).toHaveLength(3)
    expect(config.upstreams[2]).toEqual({
      id: 'u3',
      baseUrl: 'https://example.com/v1',
      apiKey: 'key12345',
      timeoutMs: 30000,
      disabled: false,
    })
  })

  it('POST 无效载荷返回 400', async () => {
    const res = await request(app).post('/admin/api/upstreams').send({ id: '', baseUrl: 'not-a-url', apiKey: 'k' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_upstream')
  })

  it('POST 重复 id 返回 400', async () => {
    const res = await request(app).post('/admin/api/upstreams').send({ id: 'u1', baseUrl: 'https://x.com/v1', apiKey: 'k' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('duplicate_id')
  })

  it('PUT 部分更新：未提交字段保留，请求体中的 id 被忽略', async () => {
    const res = await request(app).put('/admin/api/upstreams/u1').send({ baseUrl: 'https://new.example.com/v1' })
    expect(res.status).toBe(200)
    expect(res.body.baseUrl).toBe('https://new.example.com/v1')
    // 未提交的 apiKey 保持原值（响应掩码）
    expect(res.body.apiKey).toBe('***1234')
    // 存储中的明文未变
    expect(store.get().upstreams[0].apiKey).toBe('sk-long-1234')

    // 请求体携带 id 不生效（路径为准）
    const res2 = await request(app).put('/admin/api/upstreams/u1').send({ id: 'hacked', baseUrl: 'https://x.example.com/v1' })
    expect(res2.status).toBe(200)
    expect(res2.body.id).toBe('u1')
  })

  it('PUT 不存在的上游返回 404', async () => {
    const res = await request(app).put('/admin/api/upstreams/nope').send({ baseUrl: 'https://x.com/v1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('upstream_not_found')
  })

  it('DELETE 删除上游并级联清理下游别名（候选清空的别名整体删除）', async () => {
    const res = await request(app).delete('/admin/api/upstreams/u2')
    expect(res.status).toBe(200)
    const config = store.get()
    // u2 被移除
    expect(config.upstreams.map((u) => u.id)).toEqual(['u1'])
    // gpt-4 保留剩余候选
    expect(config.downstreamModels['gpt-4']).toEqual([{ upstreamId: 'u1', model: 'gpt-4-u1' }])
    // only-u2 候选被清空 → 别名整体删除
    expect(config.downstreamModels['only-u2']).toBeUndefined()
  })

  it('DELETE 最后一个上游返回 400', async () => {
    // 先把配置缩减为单上游
    const config = store.get()
    store.set({ upstreams: [config.upstreams[0]], downstreamModels: config.downstreamModels }, { source: 'admin' })
    const res = await request(app).delete('/admin/api/upstreams/u1')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('last_upstream')
    // 配置未被破坏
    expect(store.get().upstreams).toHaveLength(1)
  })

  it('DELETE 不存在的上游返回 404', async () => {
    const res = await request(app).delete('/admin/api/upstreams/nope')
    expect(res.status).toBe(404)
  })
})

describe('上游连通性测试 /admin/api/upstreams/:id/test', () => {
  it('使用配置中的上游（注入客户端）测试成功', async () => {
    clients.set(
      'u1',
      fakeClient(async () => [{ id: 'm1' }, { id: 'm2' }]),
    )
    const res = await request(app).post('/admin/api/upstreams/u1/test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe(200)
    expect(res.body.modelCount).toBe(2)
    expect(typeof res.body.latencyMs).toBe('number')
  })

  it('请求体覆盖 baseUrl + apiKey（apiKey 允许为空，Ollama 风格）', async () => {
    let capturedAuth = ''
    const url = await startMock((req, res) => {
      capturedAuth = req.headers.authorization ?? ''
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))
    })
    const res = await request(app).post('/admin/api/upstreams/u1/test').send({ baseUrl: url, apiKey: '' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.modelCount).toBe(3)
    // 空 apiKey → 空 Bearer 头（axios 会裁剪尾部空格）
    expect(capturedAuth).toBe('Bearer')

    // 非空 apiKey 覆盖生效
    const res2 = await request(app).post('/admin/api/upstreams/u1/test').send({ baseUrl: url, apiKey: 'sk-ovr' })
    expect(res2.body.ok).toBe(true)
    expect(capturedAuth).toBe('Bearer sk-ovr')
  })

  it('覆盖模式下未配置的上游 id 也可测试（无需存在于配置）', async () => {
    const url = await startMock((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'only' }] }))
    })
    const res = await request(app).post('/admin/api/upstreams/brand-new/test').send({ baseUrl: url })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.modelCount).toBe(1)
  })

  it('配置模式下游不存在返回 404', async () => {
    const res = await request(app).post('/admin/api/upstreams/nope/test')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('upstream_not_found')
  })

  it('失败时优先返回 err.code（如 ECONNREFUSED）', async () => {
    clients.set(
      'u1',
      fakeClient(async () => {
        throw errWithCode('ECONNREFUSED')
      }),
    )
    const res = await request(app).post('/admin/api/upstreams/u1/test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.modelCount).toBe(0)
    expect(res.body.error).toBe('ECONNREFUSED')
    expect(typeof res.body.latencyMs).toBe('number')
  })

  it('无 code 时回退到状态码字符串', async () => {
    clients.set(
      'u1',
      fakeClient(async () => {
        throw errWithStatus(503)
      }),
    )
    const res = await request(app).post('/admin/api/upstreams/u1/test')
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('503')
  })
})

describe('候选上下文探测 /admin/api/candidates/probe-context', () => {
  // llama.cpp 格式 mock：/v1/models 返回 data[].meta.n_ctx；其余路径（含 LM Studio）返回空 data
  const llamaCppMock = (nCtx: number, modelId = 'llama3'): MockHandler => (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: modelId, meta: { n_ctx: nCtx } }] }))
      return
    }
    res.end(JSON.stringify({ data: [] }))
  }

  it('新增模式：upstreamId 未命中配置 + 显式 baseUrl → 用 baseUrl 探测', async () => {
    const url = await startMock(llamaCppMock(8192))
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'llama3', baseUrl: url })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, max_context_length: 8192 })
  })

  it('编辑模式：upstreamId 命中配置 → 用配置的 baseUrl 与真实密钥探测', async () => {
    let capturedAuth = ''
    const url = await startMock((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/models') {
        capturedAuth = req.headers.authorization ?? ''
        res.end(JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: 32768 } }] }))
        return
      }
      res.end(JSON.stringify({ data: [] }))
    })
    // 把 u1 的 baseUrl 指到 mock（BASE_CONFIG 里 u1 原本指向 127.0.0.1:1）
    const config = store.get()
    store.set(
      { ...config, upstreams: config.upstreams.map((u) => (u.id === 'u1' ? { ...u, baseUrl: url } : u)) },
      { source: 'admin' },
    )
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'u1', model: 'm' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, max_context_length: 32768 })
    // 隐含证明用的是配置里的真实密钥（sk-long-1234），而非前端掩码值
    expect(capturedAuth).toBe('Bearer sk-long-1234')
  })

  it('编辑模式：body 中非空 baseUrl/apiKey 覆盖配置值', async () => {
    let capturedAuth = ''
    const url = await startMock((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/models') {
        capturedAuth = req.headers.authorization ?? ''
        res.end(JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: 4096 } }] }))
        return
      }
      res.end(JSON.stringify({ data: [] }))
    })
    // u1 配置指向 127.0.0.1:1（不可达），仅靠 body 覆盖 baseUrl 才能探测成功
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'u1', model: 'm', baseUrl: url, apiKey: 'sk-ovr' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, max_context_length: 4096 })
    expect(capturedAuth).toBe('Bearer sk-ovr')
  })

  it('缺 upstreamId 返回 400 invalid_request + field=upstreamId', async () => {
    const res = await request(app).post('/admin/api/candidates/probe-context').send({ model: 'm' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(res.body.field).toBe('upstreamId')
  })

  it('缺 model 返回 400 invalid_request + field=model', async () => {
    const res = await request(app).post('/admin/api/candidates/probe-context').send({ upstreamId: 'u1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(res.body.field).toBe('model')
  })

  it('upstreamId 未命中 + 无 baseUrl 返回 400 invalid_request + field=baseUrl', async () => {
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'nope', model: 'm' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(res.body.field).toBe('baseUrl')
  })

  it('探测不到（mock 返回空 data）→ context_not_found', async () => {
    const url = await startMock((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [] }))
    })
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'm', baseUrl: url })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'context_not_found' })
  })

  it('探测不到（mock 返回 404）→ context_not_found', async () => {
    const url = await startMock((_req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'm', baseUrl: url })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'context_not_found' })
  })

  it('按 model 过滤：mock 同时支持两个端点 → 取 LM Studio 中 model=b 的上下文', async () => {
    const urlWithLm = await startMock((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'a', meta: { n_ctx: 8192 } }] }))
        return
      }
      if (req.url === '/api/v1/models') {
        res.end(
          JSON.stringify({
            models: [{ id: 'b', loaded_instances: [{ id: 'b', config: { context_length: 16384 } }] }],
          }),
        )
        return
      }
      res.end(JSON.stringify({ data: [] }))
    })
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'b', baseUrl: urlWithLm })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, max_context_length: 16384 })
  })

  it('网络错误（baseUrl 指向 127.0.0.1:1）→ 探测失败呈现 context_not_found', async () => {
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    // probeMaxContext 把 ECONNREFUSED 等网络错误吞成 null，端点统一按「探测不到」呈现
    expect(res.body.error).toBe('context_not_found')
  })

  it('防御分支：probeMaxContext 抛网络错误 → 返回错误代号（extractErrorCode）', async () => {
    vi.mocked(probeMaxContext).mockRejectedValueOnce(errWithCode('ECONNREFUSED'))
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'ECONNREFUSED' })
  })

  it('防御分支：probeMaxContext 抛无代号错误 → 回退 probe_failed', async () => {
    vi.mocked(probeMaxContext).mockRejectedValueOnce(new Error('boom'))
    const res = await request(app)
      .post('/admin/api/candidates/probe-context')
      .send({ upstreamId: 'new-u', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'probe_failed' })
  })
})

describe('下游模型映射 /admin/api/downstream-models', () => {
  it('GET 原样返回映射', async () => {
    const res = await request(app).get('/admin/api/downstream-models')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(BASE_CONFIG.downstreamModels)
  })

  it('PUT 整体替换并写回存储', async () => {
    const res = await request(app).put('/admin/api/downstream-models').send({
      'gpt-4': [{ upstreamId: 'u1', model: 'gpt-4o' }],
      claude: [{ upstreamId: 'u2', model: 'claude-3' }],
    })
    expect(res.status).toBe(200)
    expect(store.get().downstreamModels['claude']).toEqual([{ upstreamId: 'u2', model: 'claude-3' }])
  })

  it('PUT 空候选列表返回 400', async () => {
    const res = await request(app).put('/admin/api/downstream-models').send({ 'gpt-4': [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_downstream_models')
  })
})

describe('日志查询 /admin/api/logs', () => {
  // 2026-08-02 当日 HH:mm:ss 的本地时区 epoch ms（处理器按 date 换算本地时区当日范围，用同一本地解析保证命中）
  const dayMs = (hhmmss: string): number => new Date(`2026-08-02T${hhmmss}`).getTime()

  it('app 日志：level 过滤、keyword 过滤、倒序返回（默认 type=app）', async () => {
    logStore.insert({ type: 'app', level: 30, time: dayMs('10:00:00.000'), msg: 'downstream-ready', category: 'app' })
    logStore.insert({ type: 'app', level: 40, time: dayMs('10:00:01.000'), msg: 'upstream slow', category: 'app' })
    logStore.insert({ type: 'app', level: 50, time: dayMs('10:00:02.000'), msg: 'boom', category: 'app' })

    // 默认 type=app + level=info(30)：三条全部命中，time 倒序 → 50/40/30
    const all = await request(app).get('/admin/api/logs?date=2026-08-02')
    expect(all.status).toBe(200)
    expect(all.body.type).toBe('app')
    expect(all.body.lines.map((l: { level: number }) => l.level)).toEqual([50, 40, 30])
    expect(all.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['boom', 'upstream slow', 'downstream-ready'])

    // level=error(50)：只返回 50
    const errors = await request(app).get('/admin/api/logs?date=2026-08-02&level=error')
    expect(errors.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['boom'])

    // keyword 过滤：msg 含 upstream 的只有 40
    const byKeyword = await request(app).get('/admin/api/logs?date=2026-08-02&keyword=upstream')
    expect(byKeyword.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['upstream slow'])

    // type 互不干扰：app 记录不出现在 api 查询
    const apis = await request(app).get('/admin/api/logs?date=2026-08-02&type=api')
    expect(apis.body.lines).toEqual([])
  })

  it('api 日志：返回 camelCase 字段（requestId/method/url/status），缺省字段不出现', async () => {
    logStore.insert({
      type: 'api',
      level: 30,
      time: dayMs('10:00:00.000'),
      msg: 'request-complete',
      requestId: 'req-1',
      method: 'POST',
      url: '/v1/chat/completions',
      status: 200,
    })
    const res = await request(app).get('/admin/api/logs?type=api&date=2026-08-02')
    expect(res.status).toBe(200)
    expect(res.body.lines[0]).toEqual({
      level: 30,
      time: dayMs('10:00:00.000'),
      msg: 'request-complete',
      requestId: 'req-1',
      method: 'POST',
      url: '/v1/chat/completions',
      status: 200,
    })
    // 未提供的可选字段不出现在响应（snake_case 列名绝不外泄）
    expect(res.body.lines[0].category).toBeUndefined()
    expect(res.body.lines[0].duration_ms).toBeUndefined()
  })

  it('date 过滤：只查当日（含当日 23:59:59.999 边界，不含异日记录）', async () => {
    logStore.insert({ type: 'api', level: 30, time: dayMs('10:00:00.000'), msg: 'in-day' })
    logStore.insert({ type: 'api', level: 30, time: new Date('2026-08-02T23:59:59.999').getTime(), msg: 'day-edge' })
    logStore.insert({ type: 'api', level: 30, time: new Date('2026-08-01T10:00:00.000').getTime(), msg: 'prev-day' })
    logStore.insert({ type: 'api', level: 30, time: new Date('2026-08-03T10:00:00.000').getTime(), msg: 'next-day' })

    const res = await request(app).get('/admin/api/logs?type=api&date=2026-08-02')
    expect(res.status).toBe(200)
    expect(res.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['day-edge', 'in-day'])
  })

  it('offset/limit 分页：倒序取页，hasMore 按是否还有更早匹配行；total 始终为筛选条件下总条数', async () => {
    for (let i = 1; i <= 5; i++) {
      logStore.insert({ type: 'api', level: 30, time: dayMs(`10:00:0${i}.000`), msg: `line-${i}` })
    }

    // 第一页：最新两条 line-5/line-4，更早还有匹配 → hasMore=true；total=5（满筛选条件）
    const page1 = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&limit=2')
    expect(page1.status).toBe(200)
    expect(page1.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['line-5', 'line-4'])
    expect(page1.body.hasMore).toBe(true)
    expect(page1.body.scanned).toBe(2)
    expect(page1.body.total).toBe(5)

    // 第二页：offset=2 → line-3/line-2，分页参数回显；total 不随翻页改变
    const page2 = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&offset=2&limit=2')
    expect(page2.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['line-3', 'line-2'])
    expect(page2.body.hasMore).toBe(true)
    expect(page2.body.offset).toBe(2)
    expect(page2.body.limit).toBe(2)
    expect(page2.body.total).toBe(5)

    // 末页：offset=4 → 只剩 line-1，已无更早 → hasMore=false；total 仍=5
    const last = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&offset=4&limit=2')
    expect(last.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['line-1'])
    expect(last.body.hasMore).toBe(false)
    expect(last.body.total).toBe(5)
  })

  it('level + keyword 联合过滤：keyword 命中 msg/url，空串视为未传', async () => {
    logStore.insert({ type: 'api', level: 30, time: dayMs('10:00:00.000'), msg: 'request-complete', url: '/v1/models' })
    logStore.insert({ type: 'api', level: 40, time: dayMs('10:00:01.000'), msg: 'upstream slow' })
    logStore.insert({ type: 'api', level: 50, time: dayMs('10:00:02.000'), msg: 'boom upstream' })

    // level=error(50) + keyword=boom → 仅 50 且 msg 含 boom
    const both = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&level=error&keyword=boom')
    expect(both.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['boom upstream'])

    // keyword 命中 url 字段
    const byUrl = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&keyword=/v1/models')
    expect(byUrl.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['request-complete'])

    // keyword 空串等价于未传：三条全部返回
    const emptyKw = await request(app).get('/admin/api/logs?type=api&date=2026-08-02&keyword=')
    expect(emptyKw.body.lines).toHaveLength(3)
  })

  it('非法参数返回 400：负 offset、limit=0、limit 超上限、非法日期', async () => {
    const neg = await request(app).get('/admin/api/logs?date=2026-08-02&offset=-1')
    expect(neg.status).toBe(400)
    expect(neg.body.error).toBe('invalid_query')

    const zero = await request(app).get('/admin/api/logs?date=2026-08-02&limit=0')
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe('invalid_query')

    const over = await request(app).get('/admin/api/logs?date=2026-08-02&limit=501')
    expect(over.status).toBe(400)
    expect(over.body.error).toBe('invalid_query')

    const badDate = await request(app).get('/admin/api/logs?date=2026/08/02')
    expect(badDate.status).toBe(400)
    expect(badDate.body.error).toBe('invalid_query')
  })

  it('空库返回空行列表、scanned=0 且 hasMore=false', async () => {
    const res = await request(app).get('/admin/api/logs?date=2026-08-02')
    expect(res.status).toBe(200)
    expect(res.body.lines).toEqual([])
    expect(res.body.hasMore).toBe(false)
    expect(res.body.scanned).toBe(0)
    expect(res.body.type).toBe('app')
  })
})

describe('日志手动清理 /admin/api/logs/cleanup', () => {
  // 日志目录 = <homedir>/llmproxy/logs（beforeEach 已把 HOME 重定向到 tmpDir，getLogDir() 即指向 tmpDir/llmproxy/logs）
  const logDir = (): string => join(tmpDir, 'llmproxy', 'logs')

  it('不传 before → 缺省 7 天前，响应含 deleted/deletedFiles/before 字段', async () => {
    // 先确保日志目录存在（端点内 getLogDir 会创建，但 sweepLogsBefore 需目录已存在）
    mkdirSync(logDir(), { recursive: true })
    const now = Date.now()
    const res = await request(app).post('/admin/api/logs/cleanup')
    expect(res.status).toBe(200)
    expect(typeof res.body.deleted).toBe('number')
    expect(typeof res.body.deletedFiles).toBe('number')
    // 缺省 before ≈ now - 7 天（范围断言，容忍毫秒级耗时差）
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(res.body.before).toBeGreaterThan(now - sevenDays - 60_000)
    expect(res.body.before).toBeLessThan(now - sevenDays + 60_000)
  })

  it('传 before：DB 中 time < before 的记录被删，deleted 条数正确且响应回显 before', async () => {
    mkdirSync(logDir(), { recursive: true })
    logStore.insert({ type: 'app', level: 30, time: 1_000, msg: 'old-1' })
    logStore.insert({ type: 'app', level: 30, time: 2_000, msg: 'old-2' })
    logStore.insert({ type: 'app', level: 30, time: 3_000, msg: 'keep' })

    const res = await request(app).post('/admin/api/logs/cleanup').send({ before: 2_500 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 2, deletedFiles: 0, before: 2_500 })
    // 剩余记录验证（time 倒序最新在前）
    const after = logStore.query({
      type: 'app',
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      minLevel: 0,
      offset: 0,
      limit: 10,
    })
    expect(after.total).toBe(1)
    expect(after.rows[0].msg).toBe('keep')
  })

  it('传 before：日志文件按 mtime 清理（旧文件删除、新文件保留），deletedFiles 正确', async () => {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    // 构造文件并设置 mtime：before = 2 天前，旧文件 3 天前、新文件 1 天前、无关文件不处理
    const oldFile = join(dir, 'app-old.log')
    const freshFile = join(dir, 'app-fresh.log')
    const other = join(dir, 'service.log')
    for (const f of [oldFile, freshFile, other]) {
      writeFileSync(f, 'dummy')
    }
    const before = Date.now() - 2 * 24 * 60 * 60 * 1000
    const oldMtime = new Date(before - 24 * 60 * 60 * 1000)
    const freshMtime = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(oldFile, oldMtime, oldMtime)
    utimesSync(freshFile, freshMtime, freshMtime)

    const res = await request(app).post('/admin/api/logs/cleanup').send({ before })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 0, deletedFiles: 1, before })
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})

describe('统计 /admin/api/stats', () => {
  it('汇总 totals 与 perUpstream 明细', async () => {
    stats.recordAttempt({ upstreamId: 'u1', ok: true, durationMs: 100 })
    stats.recordAttempt({ upstreamId: 'u1', ok: false, durationMs: 200 })
    stats.recordAttempt({ upstreamId: 'u2', ok: true, durationMs: 50 })
    const res = await request(app).get('/admin/api/stats')
    expect(res.status).toBe(200)
    expect(res.body.totals).toEqual({ requests: 3, errors: 1, avgLatencyMs: 350 / 3 })
    expect(res.body.perUpstream).toEqual([
      { upstreamId: 'u1', requests: 2, errors: 1, avgLatencyMs: 150, totalLatencyMs: 300 },
      { upstreamId: 'u2', requests: 1, errors: 0, avgLatencyMs: 50, totalLatencyMs: 50 },
    ])
    // since 为合法 ISO 串
    expect(new Date(res.body.since).toISOString()).toBe(res.body.since)
  })
})

describe('健康检查与配置 /admin/api/health|config', () => {
  it('health 返回存活状态、版本与各上游健康标记（disabled → paused）', async () => {
    const res = await request(app).get('/admin/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptime).toBe('number')
    expect(res.body.version).toBe('0.3.0')
    expect(res.body.upstreams).toEqual({ u1: 'healthy', u2: 'paused' })
  })

  it('health 返回当前下行流的 host / port / baseUrl 与 listenSource（缺省 127.0.0.1:3000）', async () => {
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('127.0.0.1')
    expect(res.body.port).toBe(3000)
    // 通配监听下 baseUrl 用本机局域网 IP 生成（测试环境网卡 IP 不固定，只做形状断言）
    expect(res.body.baseUrl.startsWith('http://')).toBe(true)
    expect(res.body.baseUrl.endsWith(':3000')).toBe(true)
    expect(res.body.baseUrl.includes('0.0.0.0')).toBe(false)
    expect(res.body.listenSource).toBe('default')
  })

  it('health 在配置文件 server 节存在时反映 config 生效值', async () => {
    store.set(
      { ...store.get(), server: { host: '0.0.0.0', port: 8080 } },
      { source: 'admin' },
    )
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('0.0.0.0')
    expect(res.body.port).toBe(8080)
    // 通配监听下 baseUrl 用本机局域网 IP 生成（测试环境网卡 IP 不固定，只做形状断言）
    expect(res.body.baseUrl.startsWith('http://')).toBe(true)
    expect(res.body.baseUrl.endsWith(':8080')).toBe(true)
    expect(res.body.baseUrl.includes('0.0.0.0')).toBe(false)
    expect(res.body.listenSource).toBe('config')
  })

  it('health 在 CLI --host/--port 存在时反映 cli 生效值（覆盖 config 与 default）', async () => {
    // 配置与 cli 同时存在时 cli 优先级最高；buildApp 透传 cli 后 health 应返回 cli 值
    store.set(
      { ...store.get(), server: { host: '127.0.0.1', port: 9999 } },
      { source: 'admin' },
    )
    buildApp({ host: '0.0.0.0', port: 8080 })
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('0.0.0.0')
    expect(res.body.port).toBe(8080)
    // 通配监听下 baseUrl 用本机局域网 IP 生成（测试环境网卡 IP 不固定，只做形状断言）
    expect(res.body.baseUrl.startsWith('http://')).toBe(true)
    expect(res.body.baseUrl.endsWith(':8080')).toBe(true)
    expect(res.body.baseUrl.includes('0.0.0.0')).toBe(false)
    expect(res.body.listenSource).toBe('cli')
  })

  it('health 在仅指定 CLI --port 时 host 仍回落 config / default（相互独立）', async () => {
    // cli 只给 port，host 缺省时独立回落下一优先级（此处回落 config）
    store.set(
      { ...store.get(), server: { host: '0.0.0.0', port: 9999 } },
      { source: 'admin' },
    )
    buildApp({ port: 8080 })
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('0.0.0.0')
    expect(res.body.port).toBe(8080)
    expect(res.body.listenSource).toBe('cli')
  })

  it('config 返回完整配置且 apiKey 掩码', async () => {
    const res = await request(app).get('/admin/api/config')
    expect(res.status).toBe(200)
    expect(res.body.upstreams[0]).toEqual({
      id: 'u1',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: '***1234',
      timeoutMs: 5000,
      disabled: false,
    })
    expect(res.body.downstreamModels).toEqual(BASE_CONFIG.downstreamModels)
  })

  it('reload-error 无错误时为 null，设置后返回错误消息', async () => {
    const res = await request(app).get('/admin/api/config/reload-error')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ error: null })

    store.setRecentReloadError(new Error('watcher boom'))
    const res2 = await request(app).get('/admin/api/config/reload-error')
    expect(res2.body).toEqual({ error: 'watcher boom' })
  })
})

describe('会话粘附映射 /admin/api/sessions', () => {
  it('GET 空库返回 rows=[] 且 total=0；bind 两条后倒序返回且 total 正确', async () => {
    const empty = await request(app).get('/admin/api/sessions')
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ rows: [], total: 0 })

    sessionStore.bind('gpt-4o::chat-1', makeSessionInfo({ sessionId: 'sess-a', upstreamId: 'up-a' }))
    sessionStore.bind('gpt-4o::chat-2', makeSessionInfo({ sessionId: 'sess-b', upstreamId: 'up-b' }))
    // 手动错开 updated_at，保证倒序断言确定（不依赖 bind 的先后时序）
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-1', 100)
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-2', 200)

    const res = await request(app).get('/admin/api/sessions')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.rows.map((r: { session_key: string }) => r.session_key)).toEqual([
      'gpt-4o::chat-2',
      'gpt-4o::chat-1',
    ])
    expect(res.body.rows[0].session_id).toBe('sess-b')
    expect(res.body.rows[0].upstream_id).toBe('up-b')
  })

  it('GET client 精确过滤、keyword 模糊匹配 session_id/upstream_id、offset/limit 分页', async () => {
    sessionStore.bind('gpt-4o::chat-1', makeSessionInfo({ sessionId: 'sess-alpha', upstreamId: 'up-alpha' }))
    sessionStore.bind(
      'gpt-4o::chat-2',
      makeSessionInfo({ sessionId: 'sess-beta', upstreamId: 'up-beta', client: 'content-hash' }),
    )
    sessionStore.bind('gpt-4o::chat-3', makeSessionInfo({ sessionId: 'sess-gamma', upstreamId: 'up-gamma' }))
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-1', 100)
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-2', 200)
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-3', 300)

    // client 精确匹配
    const byClient = await request(app).get('/admin/api/sessions?client=open-webui')
    expect(byClient.body.total).toBe(2)
    expect(byClient.body.rows.map((r: { session_key: string }) => r.session_key)).toEqual([
      'gpt-4o::chat-3',
      'gpt-4o::chat-1',
    ])

    // keyword 命中 session_id
    const bySession = await request(app).get('/admin/api/sessions?keyword=beta')
    expect(bySession.body.total).toBe(1)
    expect(bySession.body.rows[0].session_id).toBe('sess-beta')

    // keyword 命中 upstream_id
    const byUpstream = await request(app).get('/admin/api/sessions?keyword=up-gamma')
    expect(byUpstream.body.total).toBe(1)
    expect(byUpstream.body.rows[0].upstream_id).toBe('up-gamma')

    // offset/limit 分页：跳过最新两条后只剩最旧一条
    const page = await request(app).get('/admin/api/sessions?offset=2&limit=1')
    expect(page.body.rows.map((r: { session_key: string }) => r.session_key)).toEqual(['gpt-4o::chat-1'])
    expect(page.body.total).toBe(3)
  })

  it('GET 非法 offset/limit 返回 400', async () => {
    const neg = await request(app).get('/admin/api/sessions?offset=-1')
    expect(neg.status).toBe(400)
    expect(neg.body.error).toBe('invalid_query')

    const zero = await request(app).get('/admin/api/sessions?limit=0')
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe('invalid_query')

    const over = await request(app).get('/admin/api/sessions?limit=501')
    expect(over.status).toBe(400)
    expect(over.body.error).toBe('invalid_query')
  })

  it('DELETE 单条：存在返回 { deleted: true } 且记录消失；不存在返回 { deleted: false }', async () => {
    sessionStore.bind('gpt-4o::chat-1', makeSessionInfo({ sessionId: 'sess-a' }))

    const gone = await request(app).delete('/admin/api/sessions/gpt-4o::chat-1')
    expect(gone.status).toBe(200)
    expect(gone.body).toEqual({ deleted: true })
    expect(sessionStore.get('gpt-4o::chat-1')).toBeUndefined()

    const missing = await request(app).delete('/admin/api/sessions/gpt-4o::no-such')
    expect(missing.status).toBe(200)
    expect(missing.body).toEqual({ deleted: false })
  })

  it('DELETE 清空返回删除条数；再次清空返回 0', async () => {
    sessionStore.bind('gpt-4o::chat-a', makeSessionInfo({ sessionId: 'sess-a' }))
    sessionStore.bind('gpt-4o::chat-b', makeSessionInfo({ sessionId: 'sess-b' }))

    const res = await request(app).delete('/admin/api/sessions')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 2 })

    const again = await request(app).delete('/admin/api/sessions')
    expect(again.body).toEqual({ deleted: 0 })
  })

  it('POST cleanup 只删过期记录并返回删除数（保留期取配置缺省 1 周）', async () => {
    const now = Date.now()
    sessionStore.bind('gpt-4o::chat-old', makeSessionInfo({ sessionId: 'sess-old' }))
    sessionStore.bind('gpt-4o::chat-new', makeSessionInfo({ sessionId: 'sess-new' }))
    // 模拟时间流逝：旧记录 10 万 ms 前、新记录 1 千 ms 前（均早于缺省保留期 1 周=604800000ms → 未过期）
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-old', now - 100_000)
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-new', now - 1_000)

    // 缺省保留期 604800000ms（1 周）：两条都未过期 → 删 0
    const none = await request(app).post('/admin/api/sessions/cleanup')
    expect(none.status).toBe(200)
    expect(none.body).toEqual({ deleted: 0 })

    // 配置把保留期缩短为 5 万 ms：旧记录过期被删，新记录保留
    store.set(
      {
        ...store.get(),
        routing: { sessionAffinity: { enabled: true, cleanupMaxAgeMs: 50_000, cleanupIntervalMs: 3600000 } },
      },
      { source: 'admin' },
    )
    const res = await request(app).post('/admin/api/sessions/cleanup')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 1 })
    expect(sessionStore.get('gpt-4o::chat-old')).toBeUndefined()
    expect(sessionStore.get('gpt-4o::chat-new')).toBeDefined()
  })

  it('POST cleanup 配置保留期为 0（永不过期）时跳过清理', async () => {
    sessionStore.bind('gpt-4o::chat-old', makeSessionInfo({ sessionId: 'sess-old' }))
    setSessionUpdatedAt(sessionDbPath, 'gpt-4o::chat-old', Date.now() - 100_000)

    store.set(
      { ...store.get(), routing: { sessionAffinity: { enabled: true, cleanupMaxAgeMs: 0, cleanupIntervalMs: 0 } } },
      { source: 'admin' },
    )
    const res = await request(app).post('/admin/api/sessions/cleanup')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 0 })
    expect(sessionStore.get('gpt-4o::chat-old')).toBeDefined()
  })
})

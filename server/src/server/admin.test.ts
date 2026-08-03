// 管理端 REST 接口测试：supertest + 真实 ConfigStore（临时目录）+ 可注入假客户端
// 覆盖：上游 CRUD 与密钥掩码、级联删除、最后一个上游保护、连通性测试（覆盖/配置两种模式、各类错误代号）、
//       下游模型映射整体替换、日志级别/关键词过滤、统计汇总、健康检查、配置掩码与重载错误
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../config/store.js'
import { StatsCounter } from '../stats/counter.js'
import type { OpenAIUpstreamClient } from '../upstream/openai.js'
import { registerAdminRoutes } from './admin.js'

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

// 每次测试的共享状态
let tmpDir = ''
let store: ConfigStore
let stats: StatsCounter
let app: Express
let clients: Map<string, OpenAIUpstreamClient>

// 构造被测应用：express.json（装配层职责）+ 管理端路由
function buildApp(): void {
  app = express()
  app.use(express.json())
  registerAdminRoutes(app, {
    store,
    getUpstreamClient: (id) => clients.get(id),
    stats,
  })
}

beforeEach(() => {
  // 每个用例独立的临时配置目录；同时把日志目录（homedir/llmproxy/logs）重定向到临时目录
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  clients = new Map()
  buildApp()
  // Windows 读 USERPROFILE，POSIX 读 HOME：两个都 stub 才跨平台生效
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
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
  it('按级别阈值过滤（默认 info）并跳过非 JSON 行', async () => {
    // 日志目录重定向到临时目录（beforeEach stub 了 USERPROFILE/HOME）
    const logDir = join(tmpDir, 'llmproxy', 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'app-2026-08-02.log'),
      [
        JSON.stringify({ level: 30, msg: 'request-complete', url: '/v1/models' }),
        JSON.stringify({ level: 40, msg: 'upstream slow' }),
        JSON.stringify({ level: 50, msg: 'boom' }),
        'not-json-line',
      ].join('\n') + '\n',
    )
    const res = await request(app).get('/admin/api/logs?date=2026-08-02')
    expect(res.status).toBe(200)
    // info=30：30/40/50 全部满足 ≥30；非 JSON 行被跳过
    expect(res.body.lines.map((l: { level: number }) => l.level)).toEqual([30, 40, 50])
  })

  it('level + keyword 联合过滤', async () => {
    const logDir = join(tmpDir, 'llmproxy', 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'app-2026-08-02.log'),
      [
        JSON.stringify({ level: 30, msg: 'request-complete' }),
        JSON.stringify({ level: 40, msg: 'upstream slow' }),
        JSON.stringify({ level: 50, msg: 'boom upstream' }),
      ].join('\n') + '\n',
    )
    // level=error(50) + keyword=boom → 仅 50 且 msg 含 boom
    const res = await request(app).get('/admin/api/logs?date=2026-08-02&level=error&keyword=boom')
    expect(res.body.lines).toHaveLength(1)
    expect(res.body.lines[0].msg).toBe('boom upstream')

    // 仅 keyword=upstream（默认 info）→ 40 与 50 命中
    const res2 = await request(app).get('/admin/api/logs?date=2026-08-02&keyword=upstream')
    expect(res2.body.lines.map((l: { msg: string }) => l.msg)).toEqual(['upstream slow', 'boom upstream'])
  })

  it('文件不存在返回空行列表', async () => {
    const res = await request(app).get('/admin/api/logs?date=2026-08-01')
    expect(res.status).toBe(200)
    expect(res.body.lines).toEqual([])
  })

  it('非法日期格式返回 400', async () => {
    const res = await request(app).get('/admin/api/logs?date=2026/08/02')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_query')
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
    expect(res.body.version).toBe('0.1.0')
    expect(res.body.upstreams).toEqual({ u1: 'healthy', u2: 'paused' })
  })

  it('health 返回当前下行流的 host / port / baseUrl 与 listenSource（缺省 127.0.0.1:3000）', async () => {
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('127.0.0.1')
    expect(res.body.port).toBe(3000)
    expect(res.body.baseUrl).toBe('http://127.0.0.1:3000')
    expect(res.body.listenSource).toBe('default')
  })

  it('health 在 env PORT 覆盖时反映 env 生效值', async () => {
    vi.stubEnv('PORT', '9999')
    try {
      const res = await request(app).get('/admin/api/health')
      expect(res.body.host).toBe('127.0.0.1')
      expect(res.body.port).toBe(9999)
      expect(res.body.baseUrl).toBe('http://127.0.0.1:9999')
      expect(res.body.listenSource).toBe('env')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('health 在配置文件 server 节存在时反映 config 生效值（env 不存在时）', async () => {
    store.set(
      { ...store.get(), server: { host: '0.0.0.0', port: 8080 } },
      { source: 'admin' },
    )
    const res = await request(app).get('/admin/api/health')
    expect(res.body.host).toBe('0.0.0.0')
    expect(res.body.port).toBe(8080)
    expect(res.body.baseUrl).toBe('http://0.0.0.0:8080')
    expect(res.body.listenSource).toBe('config')
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

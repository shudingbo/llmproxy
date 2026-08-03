// OpenAI 下游服务模块测试：supertest + 真实 ConfigStore + http.createServer 模拟上游
// 覆盖：非流式透传、流式透传、模型列表聚合与缓存、顺序回退、全失败 502、未知模型 404
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../config/store.js'
import { Router } from '../router/index.js'
import { RoundRobinLoadBalancer, SessionAffinityLoadBalancer, type SessionStoreLike } from '../router/load-balancer.js'
import type { SessionBindInfo } from '../session/db.js'
import { OpenAIUpstreamClient } from '../upstream/openai.js'
import { registerOpenAIRoutes, type OpenAIDeps } from './openai.js'

// 模拟上游服务器处理器类型
type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

// 基础配置模板：u1/u2 两个上游，gpt-4 别名按顺序引用两者（先 u1 后 u2）
const BASE_CONFIG = {
  upstreams: [
    { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', timeoutMs: 5000, disabled: false },
    { id: 'u2', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k2', timeoutMs: 5000, disabled: false },
  ],
  downstreamModels: {
    'gpt-4': [
      { upstreamId: 'u1', model: 'gpt-4-u1' },
      { upstreamId: 'u2', model: 'gpt-4-u2' },
    ],
  },
}

// 已启动的模拟上游服务器（afterEach 统一强制断开并关闭）
const servers: Server[] = []

// 启动一个模拟上游，返回 baseUrl（形如 http://127.0.0.1:PORT/v1）
async function startMock(handler: MockHandler): Promise<string> {
  const srv = createServer((req, res) => {
    // 处理器内的异常转成 500 响应，避免拖垮测试进程
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

/** 读取并解析请求体 JSON */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? undefined : JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

// 每次测试的共享状态
let tmpDir = ''
let store: ConfigStore
let app: Express
let clients: Map<string, OpenAIUpstreamClient>
const attempts: Array<{ upstreamId: string; ok: boolean; durationMs: number; status?: number }> = []

// 内存 fake 会话存储：实现 SessionStoreLike（get/touch/bind/rebind）并记录调用，供会话亲和用例断言
class FakeSessionStore implements SessionStoreLike {
  records = new Map<string, { upstream_id: string }>()
  bindCalls: Array<{ sessionKey: string; upstreamId: string; client: string }> = []
  rebindCalls: Array<{ sessionKey: string; upstreamId: string; upstreamModel: string }> = []

  get(sessionKey: string): { upstream_id: string } | undefined {
    const record = this.records.get(sessionKey)
    return record ? { upstream_id: record.upstream_id } : undefined
  }

  touch(): boolean {
    return true
  }

  bind(sessionKey: string, info: SessionBindInfo): void {
    this.bindCalls.push({ sessionKey, upstreamId: info.upstreamId, client: info.client })
    this.records.set(sessionKey, { upstream_id: info.upstreamId })
  }

  rebind(sessionKey: string, upstreamId: string, upstreamModel: string): void {
    this.rebindCalls.push({ sessionKey, upstreamId, upstreamModel })
    this.records.set(sessionKey, { upstream_id: upstreamId })
  }
}

// 构造被测应用：express.json（装配层职责）+ openai 路由；传入会话存储时启用会话亲和均衡器
function buildApp(session?: SessionStoreLike): void {
  app = express()
  app.use(express.json())
  registerOpenAIRoutes(app, {
    store,
    getUpstreamClient: (id) => clients.get(id),
    router: new Router(store.get()),
    loadBalancer:
      session !== undefined ? new SessionAffinityLoadBalancer(session, new RoundRobinLoadBalancer()) : new RoundRobinLoadBalancer(),
    onAttempt: (info) => {
      attempts.push(info)
    },
    sessionStore: session,
  } satisfies OpenAIDeps)
}

// 新建客户端并登记到注入集合
function addClient(id: string, baseUrl: string): void {
  clients.set(id, new OpenAIUpstreamClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 }))
}

beforeEach(() => {
  // 每个用例独立的临时配置目录
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-openai-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  clients = new Map()
  attempts.length = 0
  buildApp()
})

afterEach(async () => {
  // 先强制断开保持打开的连接（如未结束的 SSE），再依次关闭服务器
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

describe('OpenAI 下游服务', () => {
  it('非流式请求透传到上游并回写 200 响应体', async () => {
    // 捕获上游收到的请求体，断言模型名已被改写为上游侧名称
    let captured: unknown
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
        }),
      )
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = res.body as { id?: string; choices?: Array<{ message?: { content?: string } }> }
    expect(body.id).toBe('chatcmpl-1')
    expect(body.choices?.[0]?.message?.content).toBe('你好')
    // 上游收到的是候选模型名（非别名），且强制非流式
    expect(captured).toMatchObject({ model: 'gpt-4-u1', stream: false })
    // 统计钩子恰好记录一次成功尝试
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('流式请求透传 SSE 响应直到 [DONE]', async () => {
    let captured: unknown
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"id":"1","choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"id":"2","choices":[{"delta":{"content":"好"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    // SSE 响应头必须完整
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.headers['x-accel-buffering']).toBe('no')
    expect(res.headers.connection).toContain('keep-alive')
    // 响应体原样透传，以 [DONE] 收尾（末尾带空行，先 trim 再断言）
    expect(res.text).toContain('你')
    expect(res.text).toContain('好')
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    // 上游收到的是候选模型名，且强制流式 + 注入 usage 统计
    expect(captured).toMatchObject({ model: 'gpt-4-u1', stream: true, stream_options: { include_usage: true } })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('GET /v1/models 返回下游别名列表', async () => {
    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(200)
    const body = res.body as { object: string; data: Array<{ id: string; object: string; owned_by: string }> }
    expect(body.object).toBe('list')
    // 返回的是 downstreamModels 的 key（下游别名），与聊天接口可识别的模型名一致
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: 'gpt-4', object: 'model', owned_by: 'gateway' })
  })

  it('多次请求 /v1/models 都返回一致的别名列表（不再访问上游）', async () => {
    const res1 = await request(app).get('/v1/models')
    const res2 = await request(app).get('/v1/models')
    expect(res1.body).toEqual(res2.body)
    expect((res1.body as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['gpt-4'])
  })

  it('配置变更后模型列表立即反映新别名（无需缓存，直接读配置）', async () => {
    const first = await request(app).get('/v1/models')
    expect((first.body as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['gpt-4'])

    // 管理端新增别名 extra
    const current = store.get()
    store.set(
      {
        ...current,
        downstreamModels: { ...current.downstreamModels, extra: [{ upstreamId: 'u1', model: 'extra-up' }] },
      },
      { source: 'admin' },
    )

    const after = await request(app).get('/v1/models')
    const ids = (after.body as { data: Array<{ id: string }> }).data.map((m) => m.id).sort()
    // 配置变更后立即返回新别名（无需缓存失效，直接从配置读取）
    expect(ids).toEqual(['extra', 'gpt-4'])
  })

  it('上游 500 时回退到下一个候选并最终 200', async () => {
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'boom' }))
    })
    const url2 = await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', choices: [] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/chat/completions').send({ model: 'gpt-4', messages: [] })
    expect(res.status).toBe(200)
    expect((res.body as { id?: string }).id).toBe('ok')
    // 两次尝试：u1 失败（500）+ u2 成功
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 500 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true })
  })

  it('全部上游失败时返回 502 no_upstream', async () => {
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 500
      res.end('err')
    })
    const url2 = await startMock(async (req, res) => {
      res.statusCode = 503
      res.end('err')
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/chat/completions').send({ model: 'gpt-4', messages: [] })
    expect(res.status).toBe(502)
    expect(res.body as { error?: string }).toMatchObject({ error: 'no_upstream' })
    // 两次尝试均失败
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts.every((a) => !a.ok)).toBe(true)
  })

  it('未知模型返回 404 model_not_found', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ model: 'nope', messages: [] })
    expect(res.status).toBe(404)
    expect(res.body as { error?: string }).toEqual({ error: 'model_not_found' })
    // 未发起任何尝试
    expect(attempts).toHaveLength(0)
  })
})

describe('OpenAI 会话亲和路由', () => {
  it('带 X-OpenWebUI-Chat-Id 的请求按会话粘附同一上游', async () => {
    let hitU1 = 0
    let hitU2 = 0
    const url1 = await startMock(async (req, res) => {
      hitU1++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [] }))
    })
    const url2 = await startMock(async (req, res) => {
      hitU2++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'c2', object: 'chat.completion', choices: [] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)
    const session = new FakeSessionStore()
    buildApp(session)

    const send = (): request.Test =>
      request(app)
        .post('/v1/chat/completions')
        .set('X-OpenWebUI-Chat-Id', 'chat-1')
        .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const res1 = await send()
    expect(res1.status).toBe(200)
    // 首次请求绑定会话：会话键格式 ${下游模型}::${raw}，client 标记 open-webui
    expect(session.bindCalls).toHaveLength(1)
    expect(session.bindCalls[0]).toMatchObject({
      sessionKey: 'gpt-4::chat-1',
      upstreamId: 'u1',
      client: 'open-webui',
    })
    expect(hitU1).toBe(1)

    // 第二次同会话请求：粘附 u1，不触碰 u2
    const res2 = await send()
    expect(res2.status).toBe(200)
    expect(hitU1).toBe(2)
    expect(hitU2).toBe(0)
  })

  it('首选上游失败回退成功后，会话粘附改绑到实际成功上游', async () => {
    let hitU1 = 0
    let hitU2 = 0
    const url1 = await startMock(async (req, res) => {
      hitU1++
      await readBody(req)
      res.statusCode = 500
      res.end('boom')
    })
    const url2 = await startMock(async (req, res) => {
      hitU2++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', choices: [] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)
    const session = new FakeSessionStore()
    buildApp(session)

    const send = (): request.Test =>
      request(app)
        .post('/v1/chat/completions')
        .set('X-OpenWebUI-Chat-Id', 'chat-2')
        .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const res1 = await send()
    expect(res1.status).toBe(200)
    // 首次：先绑 u1（轮询首选）→ u1 500 回退 u2 成功 → rebind 到 u2
    expect(session.bindCalls).toHaveLength(1)
    expect(session.bindCalls[0].upstreamId).toBe('u1')
    expect(session.rebindCalls).toEqual([
      { sessionKey: 'gpt-4::chat-2', upstreamId: 'u2', upstreamModel: 'gpt-4-u2' },
    ])

    // 第二次同会话请求：直达 u2，不再先试 u1
    const res2 = await send()
    expect(res2.status).toBe(200)
    expect(hitU1).toBe(1)
    expect(hitU2).toBe(2)
  })
})

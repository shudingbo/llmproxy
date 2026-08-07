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
import { ConfigStore } from '../../src/config/store.js'
import { Router } from '../../src/router/index.js'
import { RoundRobinLoadBalancer, SessionAffinityLoadBalancer, type SessionStoreLike } from '../../src/router/load-balancer.js'
import type { SessionBindInfo } from '../../src/session/db.js'
import { OpenAIUpstreamClient } from '../../src/upstream/openai.js'
import { registerOpenAIRoutes, type OpenAIDeps } from '../../src/server/openai.js'

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
  touchCalls: string[] = []

  get(sessionKey: string): { upstream_id: string } | undefined {
    const record = this.records.get(sessionKey)
    return record ? { upstream_id: record.upstream_id } : undefined
  }

  touch(sessionKey: string): boolean {
    this.touchCalls.push(sessionKey)
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
    expect(body.data[0]).toMatchObject({ id: 'gpt-4', object: 'model', owned_by: 'llmproxy' })
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

  it('GET /v1/models 附加聚合 n_ctx：取候选上游最小值，忽略未配置的候选', async () => {
    // gpt-4 的候选 0（u1 上跑 gpt-4-u1）配置 8192，候选 1 未配置 → 取候选 0 的 8192（候选 1 被忽略）
    const current = store.get()
    store.set(
      {
        ...current,
        downstreamModels: {
          ...current.downstreamModels,
          'gpt-4': [
            { upstreamId: 'u1', model: 'gpt-4-u1', max_context_length: 8192 },
            { upstreamId: 'u2', model: 'gpt-4-u2' },
          ],
        },
      },
      { source: 'admin' },
    )

    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(200)
    const body = res.body as { data: Array<{ id: string; meta?: { n_ctx: number } }> }
    expect(body.data[0].id).toBe('gpt-4')
    expect(body.data[0].meta).toEqual({ n_ctx: 8192 })
  })

  it('GET /v1/models 多候选上游均配置时取最小 n_ctx', async () => {
    // 两个候选分别配 8192 / 16384：聚合取最小 8192
    const current = store.get()
    store.set(
      {
        ...current,
        downstreamModels: {
          ...current.downstreamModels,
          'gpt-4': [
            { upstreamId: 'u1', model: 'gpt-4-u1', max_context_length: 8192 },
            { upstreamId: 'u2', model: 'gpt-4-u2', max_context_length: 16384 },
          ],
        },
      },
      { source: 'admin' },
    )

    const res = await request(app).get('/v1/models')
    const body = res.body as { data: Array<{ id: string; meta?: { n_ctx: number } }> }
    expect(body.data[0].meta).toEqual({ n_ctx: 8192 })
  })

  it('GET /v1/models 全部候选未配置 max_context_length 时条目不带 meta 字段', async () => {
    // BASE_CONFIG 中 gpt-4 的两个候选均未配置 max_context_length：别名无法聚合，不应出现 meta
    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(200)
    const body = res.body as { data: Array<{ id: string; meta?: { n_ctx: number } }> }
    expect(body.data[0]).not.toHaveProperty('meta')
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

describe('OpenAI Responses API（POST /v1/responses）', () => {
  it('非流式：responses 请求 → chat 上游 → responses 响应对象', async () => {
    // 捕获上游收到的请求体，断言已转换为 chat 格式
    let captured: unknown
    const url = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/responses')
      .send({ model: 'gpt-4', input: '你好', max_output_tokens: 100, temperature: 0.7 })
    expect(res.status).toBe(200)
    const body = res.body as {
      id: string
      object: string
      status: string
      model: string
      output: Array<{
        id: string
        type: string
        role: string
        status: string
        content: Array<{ type: string; text: string }>
      }>
      usage: { input_tokens: number; output_tokens: number; total_tokens: number }
    }
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
    expect(body.model).toBe('gpt-4')
    expect(body.id.startsWith('resp_')).toBe(true)
    expect(body.output).toHaveLength(1)
    expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant', status: 'completed' })
    expect(body.output[0].id.startsWith('msg_')).toBe(true)
    expect(body.output[0].content).toEqual([{ type: 'output_text', text: '你好', annotations: [] }])
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
    // 上游收到的是候选模型名 + chat 格式消息 + 强制非流式 + max_output_tokens 已映射
    expect(captured).toMatchObject({
      model: 'gpt-4-u1',
      stream: false,
      max_tokens: 100,
      temperature: 0.7,
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('instructions 前置 system 消息，数组 input 逐项映射', async () => {
    let captured: unknown
    const url = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', choices: [] }))
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/responses')
      .send({
        model: 'gpt-4',
        instructions: '你是助手',
        input: [
          { role: 'user', content: '你好' },
          { type: 'message', role: 'assistant', content: '收到' },
          { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'f', arguments: '{}' },
        ],
      })
    expect(res.status).toBe(200)
    expect(captured).toMatchObject({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '收到' },
      ],
    })
  })

  it('流式：返回 Responses SSE 事件流，delta 事件顺序正确', async () => {
    let captured: unknown
    const url = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"id":"1","choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"id":"2","choices":[{"delta":{"content":"好"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/responses')
      .send({ model: 'gpt-4', input: '你好', stream: true })
    expect(res.status).toBe(200)
    // SSE 响应头必须完整
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.headers['x-accel-buffering']).toBe('no')
    // 事件序列：created → ... → completed，delta 逐个输出
    const text = res.text
    const eventOrder = [
      'event: response.created',
      'event: response.in_progress',
      'event: response.output_item.added',
      'event: response.content_part.added',
      'event: response.output_text.delta',
      'event: response.output_text.delta',
      'event: response.output_text.done',
      'event: response.content_part.done',
      'event: response.output_item.done',
      'event: response.completed',
    ]
    let prev = -1
    for (const name of eventOrder) {
      // 同名事件（如连续两个 delta）需从上次位置之后开始查找，保证顺序断言
      const idx = text.indexOf(name, prev + 1)
      expect(idx).toBeGreaterThan(prev)
      prev = idx
    }
    // delta 内容逐个出现，completed 事件以完整响应收尾
    expect(text).toContain('"delta":"你"')
    expect(text).toContain('"delta":"好"')
    expect(text).toContain('"text":"你好"')
    expect(text).toContain('"status":"completed"')
    // 上游收到的是候选模型名 + chat 格式 + 强制流式 + usage 统计
    expect(captured).toMatchObject({
      model: 'gpt-4-u1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('未知模型返回 404 model_not_found', async () => {
    const res = await request(app).post('/v1/responses').send({ model: 'nope', input: 'hi' })
    expect(res.status).toBe(404)
    expect(res.body as { error?: string }).toEqual({ error: 'model_not_found' })
    expect(attempts).toHaveLength(0)
  })

  it('全部上游失败时返回 502 no_upstream', async () => {
    const url1 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 500
      res.end('err')
    })
    const url2 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 503
      res.end('err')
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: 'hi' })
    expect(res.status).toBe(502)
    expect(res.body as { error?: string }).toMatchObject({ error: 'no_upstream' })
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts.every((a) => !a.ok)).toBe(true)
  })

  it('首选上游失败回退到下一个候选并最终 200', async () => {
    const url1 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 500
      res.end('boom')
    })
    const url2 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'ok',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '回退成功' } }],
        }),
      )
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: 'hi' })
    expect(res.status).toBe(200)
    expect((res.body as { output: Array<{ content: Array<{ text: string }> }> }).output[0].content[0].text).toBe(
      '回退成功',
    )
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 500 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true })
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

  it('无 header 相同 input 的两次 /v1/responses 按内容 hash 命中同一会话并 touch', async () => {
    let hitU1 = 0
    let hitU2 = 0
    const url1 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions，不计入上游请求计数
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      hitU1++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'r1', object: 'response', output: [] }))
    })
    const url2 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions，不计入上游请求计数
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      hitU2++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'r2', object: 'response', output: [] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)
    const session = new FakeSessionStore()
    buildApp(session)

    const send = (): request.Test =>
      request(app).post('/v1/responses').send({ model: 'gpt-4', input: 'hi' })

    const res1 = await send()
    expect(res1.status).toBe(200)
    // 首次请求：无 header → 用归一化后的内容前缀 hash 作为会话键（client 标记 content-hash）
    expect(session.bindCalls).toHaveLength(1)
    expect(session.bindCalls[0]).toMatchObject({ upstreamId: 'u1', client: 'content-hash' })
    const sessionKey = session.bindCalls[0].sessionKey
    expect(sessionKey.startsWith('gpt-4::')).toBe(true)
    expect(hitU1).toBe(1)

    // 第二次同 input 请求：内容 hash 相同 → 命中已绑会话，touch 刷新并粘附 u1
    const res2 = await send()
    expect(res2.status).toBe(200)
    expect(session.touchCalls).toEqual([sessionKey])
    expect(hitU1).toBe(2)
    expect(hitU2).toBe(0)
  })

  it('同一内容跨协议：chat messages 与 responses input 产生相同内容 hash 会话键', async () => {
    let hitU1 = 0
    const url = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions，不计入上游请求计数
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      hitU1++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [] }))
    })
    addClient('u1', url)
    const session = new FakeSessionStore()
    buildApp(session)

    // chat 请求：messages 单条 user 消息 → 绑定 content-hash 会话键
    const res1 = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'X' }] })
    expect(res1.status).toBe(200)
    expect(session.bindCalls).toHaveLength(1)
    const sessionKey = session.bindCalls[0].sessionKey
    expect(session.bindCalls[0].client).toBe('content-hash')

    // responses 请求（input:'X'）归一化后恰为单条 user 消息 → 与 chat 单条 messages 的
    // 内容前缀 hash 相同 → 命中同一会话并 touch，不产生新绑定
    const res2 = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: 'X' })
    expect(res2.status).toBe(200)
    expect(session.touchCalls).toEqual([sessionKey])
    expect(session.bindCalls).toHaveLength(1)
    expect(hitU1).toBe(2)
  })
})

describe('OpenAI Responses 原生透传（POST /v1/responses）', () => {
  // 按用例改写配置：给上游设 responsesApi（native / convert），可选收窄为单候选别名
  // （保证轮询命中同一上游，便于请求计数断言）
  function setResponsesConfig(opts: { u1?: 'native' | 'convert'; u2?: 'native' | 'convert'; singleCandidate?: boolean }): void {
    const current = store.get()
    const modes: Array<'native' | 'convert' | undefined> = [opts.u1, opts.u2]
    store.set(
      {
        ...current,
        upstreams: current.upstreams.map((u, i) => ({ ...u, responsesApi: modes[i] ?? 'convert' })),
        downstreamModels: opts.singleCandidate
          ? { 'gpt-4': [{ upstreamId: 'u1', model: 'gpt-4-u1' }] }
          : current.downstreamModels,
      },
      { source: 'admin' },
    )
  }

  it('native 配置：不探测直接透传，mock 只收到 1 次 /v1/responses 且请求体原样（除 model/stream 改写）', async () => {
    setResponsesConfig({ u1: 'native', u2: 'native', singleCandidate: true })
    let responsesHits = 0
    let captured: unknown
    // 上游原生 Responses 响应：model 为上游侧模型名（决策 8，不回写下游别名）
    const upstreamJson = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-4-u1',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '你好', annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    const url = await startMock(async (req, res) => {
      responsesHits++
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(upstreamJson))
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/responses')
      .send({ model: 'gpt-4', input: '你好', max_output_tokens: 100, temperature: 0.7 })
    expect(res.status).toBe(200)
    // 非流式透传：上游 JSON 原样返回（深度相等），model 为候选上游侧模型名
    expect(res.body).toEqual(upstreamJson)
    expect((res.body as { model: string }).model).toBe('gpt-4-u1')
    // 请求体原样透传：仅改写 model（候选上游模型名）与强制非流式，其余字段未动
    expect(captured).toEqual({
      model: 'gpt-4-u1',
      input: '你好',
      max_output_tokens: 100,
      temperature: 0.7,
      stream: false,
    })
    // native 短路不探测：/v1/responses 只收到 1 次（即真实请求本身）
    expect(responsesHits).toBe(1)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true, status: 200 })
  })

  it('native 流式：上游 SSE 事件原样透传（不经 createResponsesStream 转换）', async () => {
    setResponsesConfig({ u1: 'native', singleCandidate: true })
    let responsesHits = 0
    let captured: unknown
    const url = await startMock(async (req, res) => {
      responsesHits++
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","model":"gpt-4-u1"}}\n\n',
      )
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n')
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n')
      res.end(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","object":"response","status":"completed","model":"gpt-4-u1"}}\n\n',
      )
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/responses')
      .send({ model: 'gpt-4', input: '你好', stream: true })
    expect(res.status).toBe(200)
    // SSE 响应头必须完整
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.headers['x-accel-buffering']).toBe('no')
    // 上游原始事件序列原样出现：透传不经 createResponsesStream 的证据是
    // 事件名/顺序与上游完全一致，且转换路径必发的中间事件（in_progress / output_item.added）不存在
    const text = res.text
    const eventOrder = [
      'event: response.created',
      'event: response.output_text.delta',
      'event: response.output_text.delta',
      'event: response.completed',
    ]
    let prev = -1
    for (const name of eventOrder) {
      // 同名事件（连续两个 delta）需从上次位置之后开始查找，保证顺序断言
      const idx = text.indexOf(name, prev + 1)
      expect(idx).toBeGreaterThan(prev)
      prev = idx
    }
    expect(text).not.toContain('event: response.in_progress')
    expect(text).not.toContain('event: response.output_item.added')
    expect(text).toContain('"delta":"你"')
    expect(text).toContain('"delta":"好"')
    // 请求体原样：仅 model 改写 + 强制流式；native 透传不注入 stream_options
    expect(captured).toEqual({ model: 'gpt-4-u1', input: '你好', stream: true })
    // 无探测请求
    expect(responsesHits).toBe(1)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('native 配置：即便 mock 能应答探测也不探测，/v1/responses 只收到真实请求', async () => {
    setResponsesConfig({ u1: 'native', singleCandidate: true })
    let probeHits = 0
    let realHits = 0
    let realBody: unknown
    const upstreamJson = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-4-u1',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const url = await startMock(async (req, res) => {
      const body = await readBody(req)
      // 探测请求特征：input:'ping'（T2 冻结的探测请求体）；native 模式不会发起，该分支只用于证明未探测
      if ((body as { input?: string }).input === 'ping') {
        probeHits++
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ object: 'response' }))
        return
      }
      realHits++
      realBody = body
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(upstreamJson))
    })
    addClient('u1', url)

    const send = (): request.Test => request(app).post('/v1/responses').send({ model: 'gpt-4', input: '你好' })

    const res1 = await send()
    expect(res1.status).toBe(200)
    // 首请求：无探测，只发 1 次真实请求，响应原样透传
    expect(res1.body).toEqual(upstreamJson)
    expect(probeHits).toBe(0)
    expect(realHits).toBe(1)
    // 真实请求体仅改写 model 与强制非流式
    expect(realBody).toEqual({ model: 'gpt-4-u1', input: '你好', stream: false })

    // 二次请求：仍然无探测，只发真实请求
    const res2 = await send()
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual(upstreamJson)
    expect(probeHits).toBe(0)
    expect(realHits).toBe(2)
    expect(attempts).toHaveLength(2)
    expect(attempts.every((a) => a.ok && a.upstreamId === 'u1')).toBe(true)
  })

  it('convert 配置：即使 mock /v1/responses 可支持也不打它，请求直达 /chat/completions', async () => {
    setResponsesConfig({ u1: 'convert', singleCandidate: true })
    let responsesHits = 0
    let chatHits = 0
    let captured: unknown
    const url = await startMock(async (req, res) => {
      // mock 的 /v1/responses 也能正常应答（可支持），但 convert 模式既不探测也不透传
      if (req.url?.startsWith('/v1/responses')) {
        responsesHits++
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-4-u1', output: [] }))
        return
      }
      chatHits++
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '转换结果' }, finish_reason: 'stop' }],
        }),
      )
    })
    addClient('u1', url)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: '你好' })
    expect(res.status).toBe(200)
    const body = res.body as { object: string; model: string; output: Array<{ content: Array<{ text: string }> }> }
    // 转换产物：chat 响应 → responses 对象（model 为下游别名）
    expect(body.object).toBe('response')
    expect(body.model).toBe('gpt-4')
    expect(body.output[0].content[0].text).toBe('转换结果')
    // 上游收到的是 chat 格式请求（responses → chat 转换产物）
    expect(captured).toMatchObject({
      model: 'gpt-4-u1',
      stream: false,
      messages: [{ role: 'user', content: '你好' }],
    })
    // /v1/responses 一次都没被打：无探测、无透传；转换路径只打 1 次 /chat/completions
    expect(responsesHits).toBe(0)
    expect(chatHits).toBe(1)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true, status: 200 })
  })

  it('404 防护：native 真实请求 404 视为不支持 → 回退下一候选成功', async () => {
    setResponsesConfig({ u1: 'native', u2: 'native' })
    const url1 = await startMock(async (req, res) => {
      // 真实透传请求返回 404：按决策 6/7 可回退下一个候选
      res.statusCode = 404
      res.end('not found')
    })
    const upstreamJson = { id: 'resp_2', object: 'response', status: 'completed', model: 'gpt-4-u2', output: [] }
    const url2 = await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(upstreamJson))
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: '你好' })
    expect(res.status).toBe(200)
    // 回退到 u2 的原样透传产物
    expect(res.body).toEqual(upstreamJson)
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 404 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true, status: 200 })
  })

  it('混合候选：候选1 原生透传失败（500）→ 候选2 转换成功（下游拿到转换产物）', async () => {
    setResponsesConfig({ u1: 'native', u2: 'convert' })
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    const url2 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-2',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '混合回退' }, finish_reason: 'stop' }],
        }),
      )
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: '你好' })
    expect(res.status).toBe(200)
    const body = res.body as { object: string; model: string; output: Array<{ content: Array<{ text: string }> }> }
    // 转换产物：chat 响应 → responses 对象（model 为下游别名）
    expect(body.object).toBe('response')
    expect(body.model).toBe('gpt-4')
    expect(body.output[0].content[0].text).toBe('混合回退')
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 500 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true, status: 200 })
  })

  it('混合候选反向：候选1 转换失败（500）→ 候选2 原生透传成功（下游拿到原样产物）', async () => {
    setResponsesConfig({ u1: 'convert', u2: 'native' })
    const url1 = await startMock(async (req, res) => {
      // /v1/responses 分流保留：convert 模式不探测不透传，转换路径只打 /chat/completions
      if (req.url?.startsWith('/v1/responses')) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 500
      res.end('boom')
    })
    const upstreamJson = { id: 'resp_3', object: 'response', status: 'completed', model: 'gpt-4-u2', output: [] }
    const url2 = await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(upstreamJson))
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: '你好' })
    expect(res.status).toBe(200)
    // 原样透传产物：model 为候选上游侧模型名（决策 8）
    expect(res.body).toEqual(upstreamJson)
    expect((res.body as { model: string }).model).toBe('gpt-4-u2')
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 500 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true, status: 200 })
  })

  it('全部候选 404 耗尽 → 502 no_upstream', async () => {
    setResponsesConfig({ u1: 'native', u2: 'native' })
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    const url2 = await startMock(async (req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/responses').send({ model: 'gpt-4', input: 'hi' })
    expect(res.status).toBe(502)
    expect(res.body as { error?: string }).toMatchObject({ error: 'no_upstream' })
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts.map((a) => a.status)).toEqual([404, 404])
    expect(attempts.every((a) => !a.ok)).toBe(true)
  })
})

describe('POST /v1/embeddings', () => {
  it('happy 透传：别名改写为上游模型名，input 及其它字段原样，响应深度相等', async () => {
    let captured: unknown
    const payload = {
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: 'gpt-4-u1',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(payload))
    })
    addClient('u1', url)

    const res = await request(app).post('/v1/embeddings').send({ model: 'gpt-4', input: 'hello world' })
    expect(res.status).toBe(200)
    // 上游响应原样回写（深度相等）
    expect(res.body).toEqual(payload)
    // 别名改写：上游收到的是候选模型名；input 及其它字段原样透传，无 stream 注入
    expect(captured).toEqual({ model: 'gpt-4-u1', input: 'hello world' })
    // 统计钩子恰好记录一次成功尝试
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true, status: 200 })
  })

  it('404 回退：u1 不支持（404）→ u2 成功，第二次尝试 model 改写为 gpt-4-u2', async () => {
    let capturedU1: unknown
    const url1 = await startMock(async (req, res) => {
      capturedU1 = await readBody(req)
      res.statusCode = 404
      res.end('not found')
    })
    let capturedU2: unknown
    const payload = {
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.9], index: 0 }],
      model: 'gpt-4-u2',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }
    const url2 = await startMock(async (req, res) => {
      capturedU2 = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(payload))
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/embeddings').send({ model: 'gpt-4', input: 'hi' })
    expect(res.status).toBe(200)
    // 响应来自 u2
    expect(res.body).toEqual(payload)
    // 两次尝试：u1 失败（404）+ u2 成功；两次 body.model 分别改写为各自候选模型名
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 404 })
    expect(attempts[1]).toMatchObject({ upstreamId: 'u2', ok: true, status: 200 })
    expect(capturedU1).toMatchObject({ model: 'gpt-4-u1' })
    expect(capturedU2).toMatchObject({ model: 'gpt-4-u2' })
  })

  it('401 立即中断：u1 鉴权失败不再尝试 u2，直接 502 no_upstream', async () => {
    let hitU2 = 0
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 401
      res.end('unauthorized')
    })
    const url2 = await startMock(async (req, res) => {
      hitU2++
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/v1/embeddings').send({ model: 'gpt-4', input: 'hi' })
    expect(res.status).toBe(502)
    // 只断言 error 字段；code 来自 axios 错误码（如 ERR_BAD_REQUEST），非 HTTP 状态码，不断言具体值
    expect(res.body as { error?: string }).toMatchObject({ error: 'no_upstream' })
    // 401 不可回退：只尝试了 u1，未触碰 u2
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: false, status: 401 })
    expect(hitU2).toBe(0)
  })

  it('未知模型别名返回 404 model_not_found', async () => {
    const res = await request(app).post('/v1/embeddings').send({ model: 'nope', input: 'hi' })
    expect(res.status).toBe(404)
    expect(res.body as { error?: string }).toEqual({ error: 'model_not_found' })
    // 未发起任何尝试
    expect(attempts).toHaveLength(0)
  })

  it('无会话粘附：带 X-OpenWebUI-Chat-Id 头也不提取会话键，存储零调用，同头请求按轮询分布', async () => {
    let hitU1 = 0
    let hitU2 = 0
    const url1 = await startMock(async (req, res) => {
      hitU1++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ embedding: [1], index: 0 }] }))
    })
    const url2 = await startMock(async (req, res) => {
      hitU2++
      await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ embedding: [2], index: 0 }] }))
    })
    addClient('u1', url1)
    addClient('u2', url2)
    const session = new FakeSessionStore()
    buildApp(session)

    const send = (): request.Test =>
      request(app)
        .post('/v1/embeddings')
        .set('X-OpenWebUI-Chat-Id', 'chat-emb')
        .send({ model: 'gpt-4', input: 'hi' })

    const res1 = await send()
    expect(res1.status).toBe(200)
    const res2 = await send()
    expect(res2.status).toBe(200)
    // embeddings 不产生会话粘附：bind/touch/rebind 零调用
    expect(session.bindCalls).toHaveLength(0)
    expect(session.touchCalls).toHaveLength(0)
    expect(session.rebindCalls).toHaveLength(0)
    // 无粘附 → 连发两次同头请求按轮询命中不同上游（u1/u2 各一次）
    expect(hitU1).toBe(1)
    expect(hitU2).toBe(1)
  })

  it('透传保真：dimensions / encoding_format / user 等字段原样到达上游', async () => {
    let captured: unknown
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ embedding: [1, 2], index: 0 }] }))
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/v1/embeddings')
      .send({ model: 'gpt-4', input: 'hello', dimensions: 256, encoding_format: 'base64', user: 'u' })
    expect(res.status).toBe(200)
    // 除 model 改写为候选模型名外，其余字段原样透传（不强制 stream、不删字段）
    expect(captured).toEqual({
      model: 'gpt-4-u1',
      input: 'hello',
      dimensions: 256,
      encoding_format: 'base64',
      user: 'u',
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })
})

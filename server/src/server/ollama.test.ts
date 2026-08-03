// Ollama 下游服务模块测试：supertest + 真实 ConfigStore + http.createServer 模拟上游
// 覆盖：非流式转发、流式转发（NDJSON）、模型列表聚合、顺序回退、全失败 502、
//       n > 1 拒绝、未知模型 404、未实现路由 404
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
import { RoundRobinLoadBalancer } from '../router/load-balancer.js'
import { OpenAIUpstreamClient } from '../upstream/openai.js'
import { registerOllamaRoutes, type OllamaDeps } from './ollama.js'

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

// 构造被测应用：express.json（装配层职责）+ ollama 路由
function buildApp(): void {
  app = express()
  app.use(express.json())
  registerOllamaRoutes(app, {
    store,
    getUpstreamClient: (id) => clients.get(id),
    router: new Router(store.get()),
    loadBalancer: new RoundRobinLoadBalancer(),
    onAttempt: (info) => {
      attempts.push(info)
    },
  } satisfies OllamaDeps)
}

// 新建客户端并登记到注入集合
function addClient(id: string, baseUrl: string): void {
  clients.set(id, new OpenAIUpstreamClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 }))
}

beforeEach(() => {
  // 每个用例独立的临时配置目录
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-ollama-'))
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  clients = new Map()
  attempts.length = 0
  buildApp()
})

afterEach(async () => {
  // 先强制断开保持打开的连接（如未结束的流式响应），再依次关闭服务器
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

describe('Ollama 下游服务', () => {
  it('非流式请求转换为 Ollama 形状后转发，并回写转换后的响应体', async () => {
    // 捕获上游收到的请求体，断言模型名已被改写为上游侧名称（Ollama 形状）
    let captured: unknown
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1700000000,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '你好' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
        }),
      )
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    // 转换后的 Ollama 非流式响应：message + done + token 计数
    const body = res.body as {
      model?: string
      message?: { role?: string; content?: string }
      done?: boolean
      done_reason?: string
      prompt_eval_count?: number
      eval_count?: number
    }
    expect(body).toMatchObject({
      model: 'gpt-4',
      message: { role: 'assistant', content: '你好' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 8,
    })
    // 上游收到的是候选模型名（非别名），且为非流式
    expect(captured).toMatchObject({ model: 'gpt-4-u1', stream: false })
    // 统计钩子恰好记录一次成功尝试
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('流式请求转发为 NDJSON：每行合法 JSON，以 done: true 收尾', async () => {
    let captured: unknown
    const url = await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"id":"1","choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"id":"2","choices":[{"delta":{"content":"好"}}]}\n\n')
      res.write('data: {"id":"3","usage":{"prompt_tokens":5,"completion_tokens":2},"choices":[]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    addClient('u1', url)

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    // NDJSON 响应头必须完整
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.headers['cache-control']).toContain('no-cache')
    // 每行都是合法 JSON（忽略空行）
    const lines = res.text.split('\n').filter((line) => line.length > 0)
    const parsed = lines.map(
      (line) =>
        JSON.parse(line) as {
          done?: boolean
          message?: { content?: string }
          prompt_eval_count?: number
          eval_count?: number
        },
    )
    expect(parsed[0]).toMatchObject({ done: false, message: { content: '你' } })
    expect(parsed[1]).toMatchObject({ done: false, message: { content: '好' } })
    // 结尾行：done: true + usage 计数（usage 块被实时捕获）
    expect(parsed[parsed.length - 1]).toMatchObject({
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 2,
    })
    // 上游收到的是候选模型名，且强制流式 + 注入 usage 统计
    expect(captured).toMatchObject({ model: 'gpt-4-u1', stream: true, stream_options: { include_usage: true } })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ upstreamId: 'u1', ok: true })
  })

  it('GET /api/tags 返回下游别名列表（Ollama 形状）', async () => {
    const res = await request(app).get('/api/tags')
    expect(res.status).toBe(200)
    const body = res.body as {
      models: Array<{ name: string; model: string; details?: { format?: string; family?: string } }>
    }
    // 返回的是 downstreamModels 的 key（下游别名）
    expect(body.models).toHaveLength(1)
    expect(body.models.map((m) => m.name)).toEqual(['gpt-4'])
    expect(body.models[0].model).toBe('gpt-4')
    expect(body.models[0]).toMatchObject({ details: { format: 'openai', family: 'openai' } })
  })

  it('多次请求 /api/tags 都返回一致的别名列表（不再访问上游）', async () => {
    const res1 = await request(app).get('/api/tags')
    const res2 = await request(app).get('/api/tags')
    expect(res1.body).toEqual(res2.body)
    expect((res1.body as { models: Array<{ name: string }> }).models.map((m) => m.name)).toEqual(['gpt-4'])
  })

  it('配置变更后 /api/tags 立即反映新别名（无需缓存，直接读配置）', async () => {
    const first = await request(app).get('/api/tags')
    expect((first.body as { models: Array<{ name: string }> }).models.map((m) => m.name)).toEqual(['gpt-4'])

    // 管理端新增别名 extra
    const current = store.get()
    store.set(
      {
        ...current,
        downstreamModels: { ...current.downstreamModels, extra: [{ upstreamId: 'u1', model: 'extra-up' }] },
      },
      { source: 'admin' },
    )

    const after = await request(app).get('/api/tags')
    const names = (after.body as { models: Array<{ name: string }> }).models.map((m) => m.name).sort()
    // 配置变更后立即返回新别名（直接读配置，无缓存）
    expect(names).toEqual(['extra', 'gpt-4'])
  })

  it('GET /api/version 返回 Ollama 兼容版本号', async () => {
    const res = await request(app).get('/api/version')
    expect(res.status).toBe(200)
    const body = res.body as { version?: string }
    expect(body).toHaveProperty('version')
    expect(typeof body.version).toBe('string')
    expect(body.version!.length).toBeGreaterThan(0)
  })

  it('上游 500 时回退到下一个候选并最终 200', async () => {
    const url1 = await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'boom' }))
    })
    const url2 = await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'ok',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      )
    })
    addClient('u1', url1)
    addClient('u2', url2)

    const res = await request(app).post('/api/chat').send({ model: 'gpt-4', messages: [] })
    expect(res.status).toBe(200)
    expect((res.body as { message?: { content?: string } }).message?.content).toBe('ok')
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

    const res = await request(app).post('/api/chat').send({ model: 'gpt-4', messages: [] })
    expect(res.status).toBe(502)
    expect(res.body as { error?: string }).toMatchObject({ error: 'no_upstream' })
    // 两次尝试均失败
    expect(attempts.map((a) => a.upstreamId)).toEqual(['u1', 'u2'])
    expect(attempts.every((a) => !a.ok)).toBe(true)
  })

  it('n > 1 的请求直接返回 400 n_not_supported', async () => {
    const res = await request(app).post('/api/chat').send({ model: 'gpt-4', n: 2, messages: [] })
    expect(res.status).toBe(400)
    expect(res.body as { error?: string }).toEqual({
      error: 'n_not_supported',
      message: 'Ollama converter does not support n > 1',
    })
    // 未发起任何尝试
    expect(attempts).toHaveLength(0)
  })

  it('未知模型返回 404 model_not_found', async () => {
    const res = await request(app).post('/api/chat').send({ model: 'nope', messages: [] })
    expect(res.status).toBe(404)
    expect(res.body as { error?: string }).toEqual({ error: 'model_not_found' })
    // 未发起任何尝试
    expect(attempts).toHaveLength(0)
  })

  it('未实现的路由（/api/show）返回 404', async () => {
    const res = await request(app).post('/api/show').send({ model: 'gpt-4' })
    // 未注册路由 → Express 默认 404（不落入本模块的任何处理器）
    expect(res.status).toBe(404)
    expect(attempts).toHaveLength(0)
  })
})

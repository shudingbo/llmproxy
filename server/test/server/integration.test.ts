// 集成测试：真实 Express 网关 + 真实 http mock 上游（supertest 驱动，随机端口）
// 覆盖：OpenAI/Ollama 两条链路、SSE/NDJSON 流式、顺序回退、暂停路由、配置热重载、
// 统计计数、客户端鉴权头替换（绝不透传 SECRET123）与上游错误体脱敏（api_key 不泄漏）
// 注意：日志器单例的目标流在首次写日志时固定，因此整个文件共享一个临时目录（beforeAll stub 环境变量）
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FSWatcher } from 'chokidar'
import { ConfigStore } from '../../src/config/store.js'
import { startConfigWatcher } from '../../src/config/watcher.js'
import { configureLogging, flushLoggerSync } from '../../src/logger/index.js'
import { getLocalDateString } from '../../src/paths.js'
import type { Config } from '../../src/config/schema.js'
import { createApp } from '../../src/server/index.js'

// mock 上游记录到的请求（用于断言上游实际收到的头 / 请求体）
interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

// mock 上游行为：ok=总是成功、err500=总是 500、leak500=500 且响应体带 api_key 字段
type MockBehavior = 'ok' | 'err500' | 'leak500'

// 一个可用的 mock 上游：baseUrl 供配置引用，requests 记录收到的全部请求
interface MockUpstream {
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

/**
 * 按行为分发 mock 响应：
 * - GET /v1/models：所有行为都返回一个占位模型（连通性/模型列表用）
 * - 失败行为：先回 HTTP 500（body 按行为区分，leak500 携带 api_key）
 * - ok 行为：按请求体 stream 标志返回 SSE 流或普通 JSON
 */
function handleRequest(behavior: MockBehavior, req: IncomingMessage, res: ServerResponse, body: unknown): void {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'model-mock' }] }))
    return
  }
  if (behavior === 'err500') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'mock internal error' }))
    return
  }
  if (behavior === 'leak500') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'mock boom', api_key: 'sk-leak' }))
    return
  }
  // ok：流式请求返回 SSE（两条数据块 + DONE 结尾），否则返回普通 JSON
  const streamFlag = (body as { stream?: unknown } | null)?.stream === true
  if (streamFlag) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(
      'data: {"id":"cmpl-mock","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
    )
    res.write(
      'data: {"id":"cmpl-mock","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    res.end('data: [DONE]\n\n')
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'cmpl-mock',
      object: 'chat.completion',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }),
  )
}

/**
 * 启动一个真实 HTTP mock 上游（127.0.0.1 随机端口），记录全部收到的请求。
 * close() 会先断开所有连接再关服，避免 keep-alive 连接阻塞退出。
 */
async function createMockUpstream(behavior: MockBehavior): Promise<MockUpstream> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    // 先收完请求体再分发（网关请求总是带 JSON 体）
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      let body: unknown = null
      if (raw !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      })
      handleRequest(behavior, req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock 上游监听失败')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// 快速构建双上游配置：u1 指向 ok 上游、u2 指向 err500 上游，别名 gpt-4 按顺序候选
function buildTwoUpstreamConfig(ok: MockUpstream, bad: MockUpstream): Config {
  return {
    upstreams: [
      { id: 'u1', baseUrl: ok.baseUrl, apiKey: 'sk-upstream-u1', timeoutMs: 5000, disabled: false },
      { id: 'u2', baseUrl: bad.baseUrl, apiKey: 'sk-upstream-u2', timeoutMs: 5000, disabled: false },
    ],
    downstreamModels: {
      'gpt-4': [
        { upstreamId: 'u1', model: 'model-a' },
        { upstreamId: 'u2', model: 'model-b' },
      ],
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 文件级共享状态：临时目录（日志单例目标流固定于此）、当前 store/app、watcher 与 mock 集合
let tmpDir = ''
let configFileCounter = 0
let store: ConfigStore
let app: ReturnType<typeof createApp>
let watcher: FSWatcher | null = null
const mocks: MockUpstream[] = []

// 以给定配置启动一个独立网关（写配置 → 建 store → 建 app），webDistPath 指向不存在的目录
function startGateway(config: Config): void {
  configFileCounter += 1
  const cfgPath = join(tmpDir, `config-${configFileCounter}.jsonc`)
  writeFileSync(cfgPath, JSON.stringify(config))
  store = new ConfigStore(cfgPath)
  app = createApp({ store, webDistPath: join(tmpDir, 'no-web-dist') })
}

// 读取当日 API 日志文件全文（log4js 异步落盘：轮询直至有内容）。
// request-complete（含脱敏请求头）写入 api-<date>.log；app-<date>.log 只放调试信息
async function readLogText(type: 'app' | 'api' = 'api'): Promise<string> {
  const logPath = join(tmpDir, 'llmproxy', 'logs', `${type}-${getLocalDateString(new Date())}.log`)
  const deadline = Date.now() + 3000
  for (;;) {
    flushLoggerSync()
    try {
      const text = readFileSync(logPath, 'utf-8')
      if (text.length > 0) {
        return text
      }
    } catch {
      // 文件尚未创建：继续轮询
    }
    if (Date.now() > deadline) {
      throw new Error(`日志文件未就绪: ${logPath}`)
    }
    await sleep(50)
  }
}

beforeAll(() => {
  // 整个文件共享一个临时目录：日志器单例的目标流在首次写日志时固定，不能每用例更换
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-itg-'))
  vi.stubEnv('HOME', tmpDir)
  vi.stubEnv('USERPROFILE', tmpDir)
  // 必须显式初始化 log4js（曾经的 pino 在 import 时即初始化；log4js 改为按需）
  // 这样 requestLogger 才能找到 api file appender，正常写到 tmpDir/llmproxy/logs/api-<date>.log
  configureLogging()
})

beforeEach(() => {
  mocks.length = 0
  watcher = null
})

afterAll(async () => {
  for (const mock of mocks) {
    await mock.close()
  }
  if (watcher) {
    await watcher.close()
  }
  vi.unstubAllEnvs()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('网关集成测试（真实 mock 上游）', () => {
  it('POST /v1/chat/completions：命中上游 A 并透传响应', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = res.body as { id: string; choices: Array<{ message: { content: string } }> }
    expect(body.id).toBe('cmpl-mock')
    expect(body.choices[0].message.content).toBe('hello from mock')
    // 上游 A 收到改写后的候选模型名与强制非流式标记；B 未被请求
    expect(ok.requests.length).toBe(1)
    const sent = ok.requests[0].body as { model: string; stream: boolean }
    expect(sent.model).toBe('model-a')
    expect(sent.stream).toBe(false)
    expect(bad.requests.length).toBe(0)
  })

  it('禁用上游 A：请求回退到上游 B（B 恒 500 → 502）', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    const config = buildTwoUpstreamConfig(ok, bad)
    // 配置层面直接禁用 A：路由应跳过 A、只尝试 B
    config.upstreams[0].disabled = true
    startGateway(config)

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    // 路由已切到 B：A 一次都没收到，B 收到 1 次
    expect(ok.requests.length).toBe(0)
    expect(bad.requests.length).toBe(1)
  })

  it('两个上游都失败：返回 502 { error: no_upstream }', async () => {
    const bad1 = await createMockUpstream('err500')
    const bad2 = await createMockUpstream('err500')
    mocks.push(bad1, bad2)
    startGateway({
      upstreams: [
        { id: 'u1', baseUrl: bad1.baseUrl, apiKey: 'k1', timeoutMs: 5000, disabled: false },
        { id: 'u2', baseUrl: bad2.baseUrl, apiKey: 'k2', timeoutMs: 5000, disabled: false },
      ],
      downstreamModels: {
        'gpt-4': [
          { upstreamId: 'u1', model: 'm1' },
          { upstreamId: 'u2', model: 'm2' },
        ],
      },
    })

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    // 顺序回退：A 失败后确实尝试了 B（两个上游各收到 1 次）
    expect(bad1.requests.length).toBe(1)
    expect(bad2.requests.length).toBe(1)
  })

  it('POST /v1/chat/completions 流式：SSE 响应头 + 数据块 + DONE 结尾', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    expect(res.headers['cache-control']).toContain('no-cache')
    const text = res.text.trimEnd()
    expect(text).toContain('data: {"id":"cmpl-mock"')
    expect(text.endsWith('data: [DONE]')).toBe(true)
    // 上游收到强制流式标记与候选模型名
    const sent = ok.requests[0].body as { model: string; stream: boolean }
    expect(sent.model).toBe('model-a')
    expect(sent.stream).toBe(true)
  })

  it('POST /api/chat：Ollama 请求转 OpenAI 上游，响应转回 Ollama 形状', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: '你好' }], stream: false })
    expect(res.status).toBe(200)
    const body = res.body as { model: string; done: boolean; message: { role: string; content: string } }
    expect(body.done).toBe(true)
    expect(body.message.role).toBe('assistant')
    expect(body.message.content).toBe('hello from mock')
    expect(body.model).toBe('gpt-4') // model 字段回填下游别名
    // 上游收到的是 OpenAI 形状的请求（模型名替换为候选模型名，消息原样透传）
    const sent = ok.requests[0].body as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> }
    expect(sent.model).toBe('model-a')
    expect(sent.stream).toBe(false)
    expect(sent.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('POST /api/chat 流式：NDJSON 数据块 + 末尾 done: true', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const lines = res.text.split('\n').filter((line) => line.trim() !== '')
    // 至少一条内容块，且最后一行是唯一 done: true 结束行
    expect(lines.some((line) => line.includes('"content":"hello"'))).toBe(true)
    const last = JSON.parse(lines[lines.length - 1]) as { done: boolean }
    expect(last.done).toBe(true)
  })

  it('POST /api/chat 带 n: 2：400 { error: n_not_supported }（不发起上游请求）', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], n: 2 })
    expect(res.status).toBe(400)
    const body = res.body as { error: string }
    expect(body.error).toBe('n_not_supported')
    expect(ok.requests.length).toBe(0)
    expect(bad.requests.length).toBe(0)
  })

  it('客户端 Authorization 被配置密钥替换，SECRET123 不出现在上游请求与日志中', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer SECRET123')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)

    // 上游收到的鉴权头来自配置（sk-upstream-u1），绝不是客户端传入的 SECRET123
    expect(ok.requests.length).toBe(1)
    const authHeader = ok.requests[0].headers.authorization
    expect(authHeader).toBe('Bearer sk-upstream-u1')
    expect(authHeader.includes('SECRET123')).toBe(false)
    // 日志全文（含 request-complete 的脱敏请求头）不得出现 SECRET123
    const logText = await readLogText()
    expect(logText.includes('SECRET123')).toBe(false)
  })

  it('修改配置文件后等待防抖：新配置自动生效（别名改指 B）', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))
    // 启动文件监听（与生产装配同一 watcher）：外部改文件后自动重载
    const cfgPath = join(tmpDir, `config-${configFileCounter}.jsonc`)
    watcher = startConfigWatcher(cfgPath, store)
    await once(watcher, 'ready')

    // 变更前：命中 A → 200
    let res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)

    // 改写配置文件：别名只指向 B（err500），A 标记为禁用
    const updated: Config = {
      upstreams: [
        { id: 'u1', baseUrl: ok.baseUrl, apiKey: 'sk-upstream-u1', timeoutMs: 5000, disabled: true },
        { id: 'u2', baseUrl: bad.baseUrl, apiKey: 'sk-upstream-u2', timeoutMs: 5000, disabled: false },
      ],
      downstreamModels: { 'gpt-4': [{ upstreamId: 'u2', model: 'model-b' }] },
    }
    writeFileSync(cfgPath, JSON.stringify(updated))
    // watcher 防抖 200ms + 事件传播冗余：等待 500ms 再断言新配置生效
    await sleep(500)

    res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    // 变更后的请求只到达 B（A 前后共 1 次，B 共 1 次）
    expect(ok.requests.length).toBe(1)
    expect(bad.requests.length).toBe(1)
  })

  it('通过管理端暂停上游 A：新请求全部路由到 B', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    // 暂停前：命中 A → 200
    let res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)

    // 管理端 PUT 暂停 u1（写盘 → 订阅者重建客户端映射与路由）
    const putRes = await request(app).put('/admin/api/upstreams/u1').send({ disabled: true })
    expect(putRes.status).toBe(200)

    // 暂停后：只路由到 B（恒 500 → 502），A 不再收到新请求
    res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    expect(ok.requests.length).toBe(1)
    expect(bad.requests.length).toBe(1)
  })

  it('内存统计计数器：成功与失败尝试分别计数', async () => {
    const ok = await createMockUpstream('ok')
    const bad = await createMockUpstream('err500')
    mocks.push(ok, bad)
    startGateway(buildTwoUpstreamConfig(ok, bad))

    // 1 次成功（A）+ 1 次失败（B）：先暂停 A，让第二个请求只尝试 B
    await request(app).post('/v1/chat/completions').send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    await request(app).put('/admin/api/upstreams/u1').send({ disabled: true })
    await request(app).post('/v1/chat/completions').send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })

    const res = await request(app).get('/admin/api/stats')
    expect(res.status).toBe(200)
    const body = res.body as {
      totals: { requests: number; errors: number }
      perUpstream: Array<{ upstreamId: string; requests: number; errors: number }>
    }
    expect(body.totals.requests).toBe(2)
    expect(body.totals.errors).toBe(1)
    const u1 = body.perUpstream.find((s) => s.upstreamId === 'u1')
    const u2 = body.perUpstream.find((s) => s.upstreamId === 'u2')
    expect(u1).toMatchObject({ requests: 1, errors: 0 })
    expect(u2).toMatchObject({ requests: 1, errors: 1 })
  })

  it('上游失败响应带 api_key：客户端只收到脱敏错误（sk-leak 不泄漏）', async () => {
    const leaky = await createMockUpstream('leak500')
    mocks.push(leaky)
    startGateway({
      upstreams: [{ id: 'u1', baseUrl: leaky.baseUrl, apiKey: 'sk-upstream-u1', timeoutMs: 5000, disabled: false }],
      downstreamModels: { 'gpt-4': [{ upstreamId: 'u1', model: 'model-a' }] },
    })

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    // 网关统一 502 错误形状：上游响应体（含 api_key）绝不回传给客户端
    expect(body).not.toHaveProperty('api_key')
    expect(JSON.stringify(body).includes('sk-leak')).toBe(false)
  })

  it('流式 fallback：第一个上游 500 → 透明回退到第二个上游（OpenAI SSE）', async () => {
    // 配置顺序：A=err500 → B=ok，期望 A 失败后自动回退到 B 并返回成功 SSE
    const bad = await createMockUpstream('err500')
    const ok = await createMockUpstream('ok')
    mocks.push(bad, ok)
    startGateway({
      upstreams: [
        { id: 'u1', baseUrl: bad.baseUrl, apiKey: 'sk-upstream-u1', timeoutMs: 5000, disabled: false },
        { id: 'u2', baseUrl: ok.baseUrl, apiKey: 'sk-upstream-u2', timeoutMs: 5000, disabled: false },
      ],
      downstreamModels: {
        'gpt-4': [
          { upstreamId: 'u1', model: 'model-bad' },
          { upstreamId: 'u2', model: 'model-ok' },
        ],
      },
    })

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    const text = res.text.trimEnd()
    expect(text.endsWith('data: [DONE]')).toBe(true)
    expect(text).toContain('"content":"hello"')
    // 两个上游都被尝试了：A 失败 1 次、B 成功 1 次
    expect(bad.requests.length).toBe(1)
    expect(ok.requests.length).toBe(1)
  })

  it('流式 fallback：两个上游都 500 → 502 { error: no_upstream }，不发 SSE 头', async () => {
    const bad1 = await createMockUpstream('err500')
    const bad2 = await createMockUpstream('err500')
    mocks.push(bad1, bad2)
    startGateway({
      upstreams: [
        { id: 'u1', baseUrl: bad1.baseUrl, apiKey: 'k1', timeoutMs: 5000, disabled: false },
        { id: 'u2', baseUrl: bad2.baseUrl, apiKey: 'k2', timeoutMs: 5000, disabled: false },
      ],
      downstreamModels: {
        'gpt-4': [
          { upstreamId: 'u1', model: 'm1' },
          { upstreamId: 'u2', model: 'm2' },
        ],
      },
    })

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(502)
    const body = res.body as { error: string }
    expect(body.error).toBe('no_upstream')
    // 不应发送 SSE 头（连接阶段两个上游都失败 → 走纯 JSON 502 路径）
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/)
    // 两个上游各被尝试 1 次
    expect(bad1.requests.length).toBe(1)
    expect(bad2.requests.length).toBe(1)
  })

  it('流式 fallback：第一个上游 500 → 透明回退到第二个上游（Ollama NDJSON）', async () => {
    const bad = await createMockUpstream('err500')
    const ok = await createMockUpstream('ok')
    mocks.push(bad, ok)
    startGateway({
      upstreams: [
        { id: 'u1', baseUrl: bad.baseUrl, apiKey: 'sk-upstream-u1', timeoutMs: 5000, disabled: false },
        { id: 'u2', baseUrl: ok.baseUrl, apiKey: 'sk-upstream-u2', timeoutMs: 5000, disabled: false },
      ],
      downstreamModels: {
        'gpt-4': [
          { upstreamId: 'u1', model: 'model-bad' },
          { upstreamId: 'u2', model: 'model-ok' },
        ],
      },
    })

    const res = await request(app)
      .post('/api/chat')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const lines = res.text.split('\n').filter((line) => line.trim() !== '')
    expect(lines.some((line) => line.includes('"content":"hello"'))).toBe(true)
    // 末行是唯一 done: true 结束行
    const last = JSON.parse(lines[lines.length - 1]) as { done: boolean }
    expect(last.done).toBe(true)
    // 两个上游都被尝试了
    expect(bad.requests.length).toBe(1)
    expect(ok.requests.length).toBe(1)
  })
})

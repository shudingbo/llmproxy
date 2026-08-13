// OpenAI 上游客户端测试：用 Node 内置 http.createServer 模拟上游服务（随机端口）
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAIUpstreamClient, openaiClient } from '../../src/upstream/openai.js'

// 模拟服务器处理器类型
type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

let server: Server | null = null
let baseUrl = ''

/** 启动模拟上游服务器，监听随机端口，baseUrl 指向 /v1 */
async function startMock(handler: MockHandler): Promise<void> {
  const srv = createServer((req, res) => {
    // 处理器内的异常转成 500 响应，避免拖垮测试进程
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      if (!res.destroyed) {
        res.statusCode = 500
        res.end(String(err))
      }
    })
  })
  server = srv
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}/v1`
}

afterEach(async () => {
  // 强制断开所有保持打开的连接（如未结束的 SSE），再关闭服务器
  server?.closeAllConnections()
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
  server = null
})

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

/** 消费整个流直到结束，返回拼接后的文本 */
async function drain(stream: Readable): Promise<string> {
  let all = ''
  for await (const chunk of stream) {
    all += chunk.toString()
  }
  return all
}

/** 等待流的第一个数据块 */
function firstChunk(stream: Readable): Promise<Buffer> {
  return new Promise((resolve) => {
    stream.once('data', (c: Buffer) => resolve(c))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('OpenAIUpstreamClient', () => {
  it('listModels 返回模型 id 列表', async () => {
    await startMock(async (req, res) => {
      expect(req.url).toBe('/v1/models')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'gpt-4' }] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const models = await client.listModels()
    expect(models).toEqual([{ id: 'gpt-4' }])
  })

  it('baseUrl 尾部斜杠会被剥离', async () => {
    await startMock(async (req, res) => {
      expect(req.url).toBe('/v1/models')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl: `${baseUrl}/`, apiKey: 'sk-test', timeoutMs: 5000 })
    await client.listModels()
  })

  it('chatCompletion 非流式返回解析后的对象，并强制 stream=false', async () => {
    let captured: unknown
    await startMock(async (req, res) => {
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
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const res = await client.chatCompletion({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.choices[0].message?.content).toBe('你好')
    expect(captured).toMatchObject({ model: 'gpt-4', stream: false })
  })

  it('chatCompletion 收到流式请求时抛错', async () => {
    const client = new OpenAIUpstreamClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 1000 })
    await expect(
      client.chatCompletion({ model: 'm', messages: [], stream: true }),
    ).rejects.toThrow(/chatCompletionStream/)
  })

  it('chatCompletionStream 读取 SSE 分块直到 [DONE]', async () => {
    await startMock(async (req, res) => {
      expect(req.url).toBe('/v1/chat/completions')
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"id":"1","choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"id":"2","choices":[{"delta":{"content":"好"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream } = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    })
    const text = await drain(stream)
    expect(text).toContain('data: [DONE]')
    expect(text).toContain('你')
    expect(text).toContain('好')
  })

  it('includeUsage 为 true 时注入 stream_options: { include_usage: true }', async () => {
    let captured: unknown
    await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream } = client.chatCompletionStream(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { includeUsage: true },
    )
    await drain(stream)
    expect(captured).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })

  it('includeUsage 缺省时不注入 stream_options', async () => {
    let captured: unknown
    await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream } = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    await drain(stream)
    expect(captured).toMatchObject({ stream: true })
    expect(captured).not.toHaveProperty('stream_options')
  })

  it('外部 signal 中止后流被销毁且不再有数据', async () => {
    await startMock((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      // 只写第一块并保持连接打开：数据流是否终止取决于客户端是否拆线
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const controller = new AbortController()
    const { stream } = client.chatCompletionStream(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { signal: controller.signal },
    )
    const chunks: string[] = []
    stream.on('data', (c: Buffer) => {
      chunks.push(c.toString())
    })
    await firstChunk(stream)
    controller.abort()
    expect(stream.destroyed).toBe(true)
    // 等待片刻，确认没有后续数据流入
    await sleep(200)
    expect(chunks).toHaveLength(1)
  })

  it('返回的 abort() 能销毁流', async () => {
    await startMock((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream, abort } = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    await firstChunk(stream)
    abort()
    expect(stream.destroyed).toBe(true)
    await sleep(200)
  })

  it('Authorization 头携带配置中的 Bearer apiKey', async () => {
    let auth: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      auth = req.headers.authorization
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'x', choices: [] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-secret-123', timeoutMs: 5000 })
    await client.chatCompletion({ model: 'm', messages: [] })
    expect(auth).toBe('Bearer sk-secret-123')
    // 请求体里不应出现密钥（只来自配置头）
    expect(JSON.stringify(captured)).not.toContain('sk-secret-123')
  })

  it('上游返回 401 时错误携带状态码', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'bad-key', timeoutMs: 5000 })
    await expect(client.chatCompletion({ model: 'm', messages: [] })).rejects.toMatchObject({
      response: { status: 401 },
    })
  })

  it('openaiClient 工厂从 Upstream 配置构建客户端', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'gpt-4' }] }))
    })
    const client = openaiClient({ id: 'u1', baseUrl, apiKey: 'sk-x', timeoutMs: 3000, disabled: false, responsesApi: 'convert' })
    const models = await client.listModels()
    expect(models).toEqual([{ id: 'gpt-4' }])
  })

  it('chatCompletionStream 正常 SSE：connectError 解析为 null', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    // 连接阶段成功：connectError 立即 resolve 为 null
    await expect(result.connectError).resolves.toBeNull()
    await drain(result.stream)
  })

  it('chatCompletionStream 上游 500：connectError 解析为带 500 状态码的 axios 错误', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'mock boom' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    // 显式挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
    result.stream.on('error', () => {})
    const err = await result.connectError
    expect(err).toBeInstanceOf(Error)
    // axios 错误体带 response.status === 500，调用方据此识别可回退
    expect((err as unknown as { response: { status: number } }).response.status).toBe(500)
  })

  it('chatCompletionStream 上游 429：connectError 解析为 429 错误', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'rate limited' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    result.stream.on('error', () => {})
    const err = await result.connectError
    expect(err).toBeInstanceOf(Error)
    expect((err as unknown as { response: { status: number } }).response.status).toBe(429)
  })

  it('chatCompletionStream 主动 abort：connectError 解析为 null（不误判为错误）', async () => {
    await startMock((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      // 保持连接打开但暂不写数据，模拟连接建立后被客户端主动中断
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const controller = new AbortController()
    const result = client.chatCompletionStream(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { signal: controller.signal },
    )
    // 等待第一条数据进入包装流后立刻 abort
    await firstChunk(result.stream)
    controller.abort()
    // 主动中止 → connectError 应为 null（不是网络错误）
    await expect(result.connectError).resolves.toBeNull()
  })

  it('chatCompletionStream 连接拒绝：connectError 解析为网络错误', async () => {
    // 端口 1 在本地保证无服务监听 → axios 抛出 ECONNREFUSED
    const client = new OpenAIUpstreamClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      timeoutMs: 1000,
    })
    const result = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    result.stream.on('error', () => {})
    const err = await result.connectError
    expect(err).toBeInstanceOf(Error)
  })
})

// ============================================================================
// T7a 追加：Responses 原生透传方法测试（T2 新增：responsesCompletion /
// responsesCompletionStream / probeResponsesSupport）+ chatCompletionStream
// 重构零回归断言。行为对照 server/src/upstream/openai.ts 的 T2 实现。
// ============================================================================

describe('OpenAIUpstreamClient responsesCompletion', () => {
  it('非流式 POST /responses：返回解析后的对象，强制 stream=false，其余字段原样透传', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        }),
      )
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const res = await client.responsesCompletion({ model: 'gpt-4o', input: '你好', temperature: 0.7 })
    // 打 /responses（baseUrl 带 /v1 后缀），请求体强制 stream=false，透传字段原样保留
    expect(capturedUrl).toBe('/v1/responses')
    expect(captured).toMatchObject({ model: 'gpt-4o', input: '你好', temperature: 0.7, stream: false })
    expect(res).toMatchObject({ id: 'resp_1', object: 'response' })
  })

  it('responsesCompletion 收到流式请求时抛错', async () => {
    const client = new OpenAIUpstreamClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 1000 })
    await expect(
      client.responsesCompletion({ model: 'm', input: 'hi', stream: true }),
    ).rejects.toThrow(/responsesCompletionStream/)
  })
})

describe('OpenAIUpstreamClient responsesCompletionStream', () => {
  it('流式 POST /responses：SSE 数据桥接，请求体强制 stream=true', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"type":"response.output_text.delta","delta":"你"}\n\n')
      res.write('data: {"type":"response.output_text.delta","delta":"好"}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream } = client.responsesCompletionStream({
      model: 'gpt-4o',
      input: '你好',
      stream: true,
    })
    const text = await drain(stream)
    expect(capturedUrl).toBe('/v1/responses')
    expect(captured).toMatchObject({ model: 'gpt-4o', input: '你好', stream: true })
    expect(text).toContain('data: [DONE]')
    expect(text).toContain('你')
    expect(text).toContain('好')
  })

  it('正常 SSE：connectError 解析为 null', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.responsesCompletionStream({ model: 'gpt-4o', input: 'hi', stream: true })
    // 连接阶段成功：connectError 立即 resolve 为 null（与 chatCompletionStream 语义一致）
    await expect(result.connectError).resolves.toBeNull()
    await drain(result.stream)
  })

  it('上游 500：connectError 解析为带 500 状态码的 axios 错误', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'mock boom' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.responsesCompletionStream({ model: 'gpt-4o', input: 'hi', stream: true })
    // 显式挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
    result.stream.on('error', () => {})
    const err = await result.connectError
    expect(err).toBeInstanceOf(Error)
    expect((err as unknown as { response: { status: number } }).response.status).toBe(500)
  })

  it('返回的 abort() 能销毁流', async () => {
    await startMock((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"type":"response.output_text.delta","delta":"x"}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream, abort } = client.responsesCompletionStream({ model: 'gpt-4o', input: 'hi', stream: true })
    await firstChunk(stream)
    abort()
    expect(stream.destroyed).toBe(true)
    await sleep(200)
  })
})

describe('OpenAIUpstreamClient probeResponsesSupport', () => {
  it('200 + object=response → true；请求体与 url 正确', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'response', id: 'resp_1' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('gpt-4o-mini')).resolves.toBe(true)
    expect(capturedUrl).toBe('/v1/responses')
    expect(captured).toEqual({ model: 'gpt-4o-mini', input: 'ping', max_output_tokens: 1, stream: false })
  })

  it('model 缺省时探测请求体使用 gpt-4o-mini', async () => {
    let captured: unknown
    await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'response' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport()).resolves.toBe(true)
    expect((captured as { model: string }).model).toBe('gpt-4o-mini')
  })

  it('200 但 object 为 chat.completion → false（形状不符）', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'chat.completion' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).resolves.toBe(false)
  })

  it('200 但响应体为空对象 → false（形状不符）', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({}))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).resolves.toBe(false)
  })

  it('400 → true（端点存在，仅参数不被接受）', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'bad request' } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).resolves.toBe(true)
  })

  it('422 → true（端点存在，仅参数不被接受）', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 422
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'invalid' } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).resolves.toBe(true)
  })

  it.each<[string, number]>([
    ['400', 400],
    ['422', 422],
  ])('严格模式：上游返回 %s → false（非 2xx 均视为不支持）', async (desc: string, status: number) => {
    await startMock(async (req, res) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: desc } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m', true)).resolves.toBe(false)
  })

  it('严格模式：404 同样视为不支持（与默认语义一致）', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m', true)).resolves.toBe(false)
  })

  it.each<[string, number]>([
    ['404（端点不存在）', 404],
    ['405（方法不允许）', 405],
    ['401（鉴权失败）', 401],
    ['403（禁止访问）', 403],
  ])('上游返回 %s → false（确定性不支持）', async (desc: string, status: number) => {
    await startMock(async (req, res) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: desc } }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).resolves.toBe(false)
  })

  it.each<[string, number]>([
    ['500（服务端错误）', 500],
    ['429（限流）', 429],
  ])('上游返回 %s → 抛错（探测异常，由调用方按失败处理）', async (desc: string, status: number) => {
    await startMock(async (req, res) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: desc }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesSupport('m')).rejects.toThrow()
  })

  it('连接拒绝（网络错误）→ 抛错', async () => {
    // 端口 1 在本地保证无服务监听 → axios 抛出 ECONNREFUSED，probe 视为探测异常
    const client = new OpenAIUpstreamClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      timeoutMs: 1000,
    })
    await expect(client.probeResponsesSupport('m')).rejects.toThrow()
  })
})

describe('OpenAIUpstreamClient probeResponsesStream', () => {
  it('标准事件序列 → true；请求体与 url 正确', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n')
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ping"}\n\n',
      )
      res.write(
        'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"ping"}\n\n',
      )
      res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('gpt-4o-mini')).resolves.toBe(true)
    expect(capturedUrl).toBe('/v1/responses')
    expect(captured).toEqual({ model: 'gpt-4o-mini', input: 'ping', max_output_tokens: 128, stream: true })
  })

  it('model 缺省时探测请求体使用 gpt-4o-mini', async () => {
    let captured: unknown
    await startMock(async (req, res) => {
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ping"}\n\n',
      )
      res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream()).resolves.toBe(true)
    expect((captured as { model: string }).model).toBe('gpt-4o-mini')
  })

  it('仅 reasoning 无 message → false（推理模型判不支持 → convert）', async () => {
    // 实测根因场景：llama.cpp deepseek 系列探测流（max_output_tokens:128）事件序列
    // 只有 reasoning 相关事件，无任何 message 事件 → 流式完整性验证不通过
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rsn_1","type":"reasoning","summary":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.reasoning_text.delta","item_id":"rsn_1","output_index":0,"content_index":0,"delta":"think"}\n\n',
      )
      res.write(
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rsn_1","type":"reasoning","summary":[]}}\n\n',
      )
      res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })

  it('reasoning 之后出现 message 事件 → true（推理模型思考完仍正常输出 message）', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rsn_1","type":"reasoning","summary":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ping"}\n\n',
      )
      res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(true)
  })

  it('流缺失 response.completed → false', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })

  it('message delta 先于 output_item.added（缺少 added）→ false', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      // 故意漏发 response.output_item.added(message)（llama.cpp 偶发缺陷场景）
      res.write(
        'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
      )
      res.write(
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ping"}\n\n',
      )
      res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })

  it('上游返回非流式 JSON（异常）→ false', async () => {
    await startMock(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'response', id: 'resp_1' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })

  it('上游 500 → false（不抛错）', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'mock boom' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })

  it('网络错误 → false（不抛错）', async () => {
    // 端口 1 在本地保证无服务监听 → axios 抛出 ECONNREFUSED，探测视为失败
    const client = new OpenAIUpstreamClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      timeoutMs: 1000,
    })
    await expect(client.probeResponsesStream('m')).resolves.toBe(false)
  })
})

describe('chatCompletionStream 重构零回归（T7a）', () => {
  it('请求体与流行为与重构前一致：url /v1/chat/completions、强制 stream=true、透传字段原样', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const result = client.chatCompletionStream({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      stream: true,
    })
    // 连接成功 + 流数据正常桥接，行为与重构前一致
    await expect(result.connectError).resolves.toBeNull()
    const text = await drain(result.stream)
    expect(capturedUrl).toBe('/v1/chat/completions')
    expect(captured).toMatchObject({ model: 'gpt-4', stream: true, temperature: 0.5 })
    expect(text).toContain('data: [DONE]')
    expect(text).toContain('a')
  })
})

// ============================================================================
// T1 追加：createEmbedding 方法测试（POST /v1/embeddings，请求体原样透传，
// 不做任何强制改写）。行为对照 server/src/upstream/openai.ts 的 T1 实现。
// ============================================================================

describe('OpenAIUpstreamClient createEmbedding', () => {
  it('POST /v1/embeddings：请求体原样透传，返回解析后的嵌入对象', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
          model: 'gpt-4-u1',
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
      )
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const reqBody = { model: 'text-embedding-3-small', input: ['hello', 'world'], dimensions: 2 }
    const res = await client.createEmbedding(reqBody)
    // 打 /embeddings（baseUrl 带 /v1 后缀）
    expect(capturedUrl).toBe('/v1/embeddings')
    // 捕获体与传入体逐字段相等：未被改写、无多余字段注入
    expect(captured).toEqual(reqBody)
    expect(res).toEqual({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'gpt-4-u1',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    })
  })

  it('上游返回 500 时 reject，错误携带状态码', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'mock boom' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    // axios 非 2xx 抛 AxiosError，调用方据此识别可回退
    await expect(client.createEmbedding({ model: 'm', input: 'hi' })).rejects.toMatchObject({
      response: { status: 500 },
    })
  })
})

// ============================================================================
// rerank-proxy Todo 1 追加：rerank 方法测试（POST /v1/rerank，请求体原样透传，
// 不做任何强制改写）。行为对照 server/src/upstream/openai.ts 的 rerank 实现。
// ============================================================================

describe('OpenAIUpstreamClient rerank', () => {
  it('POST /v1/rerank：请求体原样透传（含多模态 documents 形状），返回解析后的重排序结果', async () => {
    let capturedUrl: string | undefined
    let captured: unknown
    await startMock(async (req, res) => {
      capturedUrl = req.url
      captured = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    // documents 元素兼容纯文本字符串与多模态对象（content 数组）两种形状
    const reqBody = {
      model: 'reranker-vl',
      query: '哪个图片里有猫',
      documents: [
        'Shanghai is the biggest city in China.',
        {
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xxx' } },
            { type: 'text', text: '一只橘猫' },
          ],
        },
      ],
      top_n: 1,
    }
    const res = await client.rerank(reqBody)
    // 打 /rerank（baseUrl 带 /v1 后缀）
    expect(capturedUrl).toBe('/v1/rerank')
    // 捕获体与传入体逐字段相等：未被改写、无多余字段注入
    expect(captured).toEqual(reqBody)
    expect(res).toEqual({ results: [{ index: 1, relevance_score: 0.9 }] })
  })

  it('baseUrl 不带 /v1 后缀时打 /rerank（版本前缀完全来自 baseUrl）', async () => {
    let capturedUrl: string | undefined
    await startMock(async (req, res) => {
      capturedUrl = req.url
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: [] }))
    })
    // 复用已启动 mock 的端口、剥掉 /v1 后缀：验证路径恒定 /rerank 的配置约定
    const noV1BaseUrl = `http://127.0.0.1:${new URL(baseUrl).port}`
    const client = new OpenAIUpstreamClient({ baseUrl: noV1BaseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await client.rerank({ model: 'reranker-vl', query: 'q', documents: ['d1', 'd2'] })
    expect(capturedUrl).toBe('/rerank')
  })

  it('上游返回 500 时 reject，错误携带状态码', async () => {
    await startMock(async (req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'mock boom' }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    // axios 非 2xx 抛 AxiosError，调用方据此识别可回退
    await expect(client.rerank({ model: 'm', query: 'q', documents: ['d'] })).rejects.toMatchObject({
      response: { status: 500 },
    })
  })
})

describe('OpenAIUpstreamClient 附加请求头', () => {
  it('options.headers 原样透传到上游请求', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> | undefined
    await startMock(async (req, res) => {
      capturedHeaders = req.headers
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'x', choices: [] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    await client.chatCompletion({ model: 'gpt-4', messages: [] }, { headers: { 'x-session-id': 'sess-1' } })
    expect(capturedHeaders?.['x-session-id']).toBe('sess-1')
  })

  it('附加头不能覆盖配置的 Authorization / Content-Type', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> | undefined
    await startMock(async (req, res) => {
      capturedHeaders = req.headers
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'x', choices: [] }))
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    // 恶意附加同名字段：鉴权头仍以配置为准
    await client.chatCompletion(
      { model: 'gpt-4', messages: [] },
      { headers: { Authorization: 'Bearer evil', 'Content-Type': 'text/plain', 'x-session-id': 'sess-2' } },
    )
    expect(capturedHeaders?.authorization).toBe('Bearer sk-test')
    expect(capturedHeaders?.['content-type']).toContain('application/json')
    expect(capturedHeaders?.['x-session-id']).toBe('sess-2')
  })

  it('流式 chatCompletionStream 同样透传 headers', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> | undefined
    await startMock(async (req, res) => {
      capturedHeaders = req.headers
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"id":"x","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const client = new OpenAIUpstreamClient({ baseUrl, apiKey: 'sk-test', timeoutMs: 5000 })
    const { stream } = client.chatCompletionStream(
      { model: 'gpt-4', messages: [], stream: true },
      { headers: { 'x-session-id': 'sess-3' } },
    )
    await drain(stream)
    expect(capturedHeaders?.['x-session-id']).toBe('sess-3')
  })
})

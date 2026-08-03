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
    const client = openaiClient({ id: 'u1', baseUrl, apiKey: 'sk-x', timeoutMs: 3000, disabled: false })
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

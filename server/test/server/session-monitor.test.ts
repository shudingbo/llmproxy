// 会话消息监控端到端测试：真实路由（/v1/chat/completions tap + /admin/api/sessions/:key/messages SSE）
// 覆盖：非流式/流式请求的消息落库、SSE 历史回放（meta + 消息）、实时推送（订阅期间新请求的消息）、
//       未知会话 404、解绑级联删除后 404
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { Router } from '../../src/router/index.js'
import { RoundRobinLoadBalancer } from '../../src/router/load-balancer.js'
import { SessionStore } from '../../src/session/db.js'
import { LogStore } from '../../src/logstore/index.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { AdminSessionStore } from '../../src/auth/session-store.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { OpenAIUpstreamClient } from '../../src/upstream/openai.js'
import { SessionMonitor } from '../../src/monitor/index.js'
import { registerAdminRoutes } from '../../src/server/admin.js'
import { registerOpenAIRoutes } from '../../src/server/openai.js'
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS, generateSessionId } from '../../src/auth/admin-auth.js'

const BASE_CONFIG = {
  upstreams: [
    { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', timeoutMs: 5000, disabled: false },
  ],
  downstreamModels: {
    'gpt-4': [{ upstreamId: 'u1', model: 'gpt-4-u1' }],
  },
}

// 读取并解析请求体 JSON
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

// 模拟上游（单端口组合）：请求体 stream=true → SSE 流（delta 拼出 'hello'）；否则非流式 JSON（回答 'hi'）
function startMockUpstream(): Promise<{ baseUrl: string; server: Server }> {
  const srv = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        if (body !== null && typeof body === 'object' && (body as { stream?: unknown }).stream === true) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
      })
      .catch((err: unknown) => {
        if (!res.destroyed) {
          res.statusCode = 500
          res.end(String(err))
        }
      })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, server: srv })
    })
  })
}

interface SseConsumeResult {
  status: number
  events: unknown[]
  ok: boolean
}

// 消费 SSE 长连接：按 \n\n 切事件块、解析 data: JSON；shouldStop 满足或超时即主动 abort（模拟抽屉关闭）
async function consumeSse(
  url: string,
  cookie: string,
  shouldStop: (events: unknown[]) => boolean,
  timeoutMs = 5000,
): Promise<SseConsumeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!res.ok || res.body === null) {
      return { status: res.status, events: [], ok: false }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const events: unknown[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine !== undefined) {
          events.push(JSON.parse(dataLine.slice(6)) as unknown)
        }
      }
      if (shouldStop(events)) {
        break
      }
    }
    controller.abort() // 主动断开 SSE 长连接（等价于关闭抽屉，服务端应退订）
    return { status: res.status, events, ok: true }
  } finally {
    clearTimeout(timer)
  }
}

const messageEvents = (events: unknown[]): Array<{ id: number; role: string; content: string }> =>
  events
    .filter((e) => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'message')
    .map((e) => {
      const m = e as { id: number; role: string; content: string }
      return { id: m.id, role: m.role, content: m.content }
    })

describe('会话消息监控（tap + SSE 端点）', () => {
  let tmpDir: string
  let gateway: Server
  let baseUrl: string // 网关地址 http://127.0.0.1:PORT
  let mock: Server
  let cookie: string
  let monitor: SessionMonitor
  let sessionStore: SessionStore
  let disposers: Array<() => void> = []

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-monitor-'))
    const cfgPath = join(tmpDir, 'config.jsonc')
    writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
    const store = new ConfigStore(cfgPath)

    const mockUpstream = await startMockUpstream()
    mock = mockUpstream.server
    // 配置 u1 指向 mock；客户端映射与配置同源
    store.set(
      { ...store.get(), upstreams: [{ ...BASE_CONFIG.upstreams[0], baseUrl: mockUpstream.baseUrl }] },
      { source: 'admin' },
    )

    // 各存储共用同一临时 db 文件（与生产装配一致的 WAL 多连接）
    const dbPath = join(tmpDir, 'llmproxy.db')
    sessionStore = new SessionStore(dbPath)
    const logStore = new LogStore(dbPath)
    const apiKeyStore = new ApiKeyStore(dbPath)
    const adminSessionStore = new AdminSessionStore(dbPath)
    monitor = new SessionMonitor(dbPath)
    disposers = [sessionStore, logStore, apiKeyStore, adminSessionStore, monitor].map((s) => () => {
      try {
        s.close()
      } catch {
        // 重复关闭忽略
      }
    })

    const clients = new Map<string, OpenAIUpstreamClient>([
      [ 'u1', new OpenAIUpstreamClient({ baseUrl: mockUpstream.baseUrl, apiKey: 'k1', timeoutMs: 5000 }) ],
    ])
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    registerAdminRoutes(app, {
      store,
      getUpstreamClient: (id) => clients.get(id),
      stats: new StatsCounter(),
      sessionStore,
      logStore,
      apiKeyStore,
      adminSessionStore,
      monitor,
    })
    registerOpenAIRoutes(app, {
      store,
      getUpstreamClient: (id) => clients.get(id),
      router: new Router(store.get()),
      loadBalancer: new RoundRobinLoadBalancer(),
      onAttempt: () => {},
      sessionStore,
      monitor,
    })

    gateway = app.listen(0)
    await new Promise<void>((resolve) => gateway.once('listening', resolve))
    const { port } = gateway.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`

    // 管理端登录态：直接落会话 + 构造 Cookie（免 login 流程，与 adminRequest 助手同思路）
    const sessionId = generateSessionId()
    adminSessionStore.create({ sessionId, username: 'admin', ttlMs: ADMIN_SESSION_TTL_MS })
    cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`
  })

  afterEach(() => {
    gateway.close()
    mock.closeAllConnections?.()
    mock.close()
    for (const dispose of disposers) {
      dispose()
    }
    disposers = []
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // 绑定会话（SSE 端点要求会话映射存在）
  const bindSession = (sessionKey: string): void => {
    sessionStore.bind(sessionKey, {
      sessionId: sessionKey.split('::')[1] ?? 'raw',
      client: 'x-session-id',
      downstreamModel: 'gpt-4',
      upstreamId: 'u1',
      upstreamModel: 'gpt-4-u1',
    })
  }

  // 非流式 chat 请求（带 X-Session-Id 会话头）
  const chatNonStream = async (sessionId: string, content: string): Promise<number> => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content }], stream: false }),
    })
    await res.arrayBuffer()
    return res.status
  }

  // 流式 chat 请求（消费完响应体即返回）
  const chatStream = async (sessionId: string, content: string): Promise<number> => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content }], stream: true }),
    })
    await res.arrayBuffer()
    return res.status
  }

  it('非流式请求：user 与 assistant 消息落库，SSE 历史回放完整', async () => {
    bindSession('gpt-4::sess-a')
    expect(await chatNonStream('sess-a', '你好')).toBe(200)

    const { status, events, ok } = await consumeSse(
      `${baseUrl}/admin/api/sessions/gpt-4%3A%3Asess-a/messages`,
      cookie,
      (evts) => messageEvents(evts).length >= 2,
    )
    expect(ok).toBe(true)
    expect(status).toBe(200)
    const meta = events.find((e) => (e as { type?: string }).type === 'meta') as {
      type: string
      total: number
      truncated: boolean
    }
    expect(meta.type).toBe('meta')
    expect(meta.total).toBe(2)
    expect(meta.truncated).toBe(false)
    expect(messageEvents(events).map((m) => [m.role, m.content])).toEqual([
      [ 'user', '你好' ],
      [ 'assistant', 'hi' ],
    ])
  })

  it('流式请求：assistant 流式结束后整条落库（delta 不逐条入库）', async () => {
    bindSession('gpt-4::sess-b')
    expect(await chatStream('sess-b', 'stream?')).toBe(200)

    const { ok, events } = await consumeSse(
      `${baseUrl}/admin/api/sessions/gpt-4%3A%3Asess-b/messages`,
      cookie,
      (evts) => messageEvents(evts).some((m) => m.role === 'assistant'),
    )
    expect(ok).toBe(true)
    expect(messageEvents(events).map((m) => [m.role, m.content])).toEqual([
      [ 'user', 'stream?' ],
      [ 'assistant', 'hello' ],
    ])
  })

  it('实时推送：抽屉订阅期间新请求的 user/assistant 消息经 SSE 实时到达', async () => {
    bindSession('gpt-4::sess-c')
    // 先建立 SSE 订阅（此时无历史）
    const promise = consumeSse(
      `${baseUrl}/admin/api/sessions/gpt-4%3A%3Asess-c/messages`,
      cookie,
      (evts) => messageEvents(evts).length >= 2,
    )
    // 稍等订阅就绪后发起新请求（100ms 足够 Express 完成 flushHeaders + subscribe 同步段）
    await new Promise((r) => setTimeout(r, 100))
    expect(await chatNonStream('sess-c', 'live-用户')).toBe(200)

    const { ok, events } = await promise
    expect(ok).toBe(true)
    // 订阅期间收到的全部是实时事件（无历史）：user + assistant 两条
    expect(messageEvents(events).map((m) => [m.role, m.content])).toEqual([
      [ 'user', 'live-用户' ],
      [ 'assistant', 'hi' ],
    ])
  })

  it('未知会话：SSE 端点 404', async () => {
    const { status, ok } = await consumeSse(
      `${baseUrl}/admin/api/sessions/gpt-4%3A%3Ano-such/messages`,
      cookie,
      () => false,
      2000,
    )
    expect(ok).toBe(false)
    expect(status).toBe(404)
  })

  it('解绑级联：DELETE 会话后监控消息一并删除，SSE 端点 404', async () => {
    bindSession('gpt-4::sess-d')
    expect(await chatNonStream('sess-d', 'will-be-gone')).toBe(200)
    expect(monitor.count('gpt-4::sess-d')).toBe(2)

    const delRes = await fetch(`${baseUrl}/admin/api/sessions/gpt-4%3A%3Asess-d`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toMatchObject({ deleted: true })
    expect(monitor.count('gpt-4::sess-d')).toBe(0)

    const { status, ok } = await consumeSse(
      `${baseUrl}/admin/api/sessions/gpt-4%3A%3Asess-d/messages`,
      cookie,
      () => false,
      2000,
    )
    expect(ok).toBe(false)
    expect(status).toBe(404)
  })
})

// 上游上下文探测单元测试：真实 http server mock（node:http），按 URL path 分流 /v1/models 与 /api/v1/models
// 覆盖：llama.cpp 优先命中、llama.cpp 无 meta 时 LM Studio 兜底、全部失败返回 null、
//       带 model 按 id 过滤、apiKey 请求头、超时与网络错误不抛错
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMaxContext } from '../../src/upstream/context.js'

// 模拟上游服务器处理器类型
type MockHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

// 已启动的模拟上游服务器（afterEach 统一关闭）
const servers: Server[] = []

// 启动一个模拟上游，返回 baseUrl（形如 http://127.0.0.1:PORT/v1；探测逻辑会剥掉 /v1 取 origin）
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

// 便捷：写 JSON 响应（默认 200）
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

// 按 URL path 分流的标准处理器：/v1/models 走 llama.cpp 格式，/api/v1/models 走 LM Studio 格式
function routedHandler(opts: {
  llama?: unknown
  llamaStatus?: number
  lmStudio?: unknown
  lmStudioStatus?: number
}): MockHandler {
  return (req, res) => {
    const path = req.url ?? ''
    if (path === '/v1/models') {
      json(res, opts.llama ?? {}, opts.llamaStatus ?? 200)
      return
    }
    if (path === '/api/v1/models') {
      json(res, opts.lmStudio ?? {}, opts.lmStudioStatus ?? 200)
      return
    }
    json(res, {}, 404)
  }
}

afterEach(async () => {
  for (const srv of servers) {
    if (srv.listening) {
      srv.closeAllConnections()
    }
  }
  for (const srv of servers) {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  servers.length = 0
})

describe('probeMaxContext', () => {
  it('llama.cpp 命中：返回 data[0].meta.n_ctx（LM Studio 返回 404 时 llama.cpp 优先）', async () => {
    const baseUrl = await startMock(
      routedHandler({
        llama: { data: [{ id: 'm1', meta: { n_ctx: 8192 } }] },
        lmStudioStatus: 404,
      }),
    )
    const result = await probeMaxContext(baseUrl)
    expect(result).toBe(8192)
  })

  it('llama.cpp 无 meta 字段 → 继续查 LM Studio → 命中 loaded_instances[0].config.context_length', async () => {
    const baseUrl = await startMock(
      routedHandler({
        // llama.cpp 有 data 但无 meta（解析不出值）
        llama: { data: [{ id: 'm1' }] },
        lmStudio: {
          models: [{ id: 'lm1', loaded_instances: [{ id: 'inst1', config: { context_length: 32768 } }] }],
        },
      }),
    )
    const result = await probeMaxContext(baseUrl)
    expect(result).toBe(32768)
  })

  it('两端点都无值/404 → 返回 null（不抛错）', async () => {
    const empty = await startMock(
      routedHandler({
        llama: { data: [] },
        lmStudio: { models: [] },
      }),
    )
    expect(await probeMaxContext(empty)).toBeNull()

    const notFound = await startMock(
      routedHandler({ llamaStatus: 404, lmStudioStatus: 404 }),
    )
    expect(await probeMaxContext(notFound)).toBeNull()
  })

  it('带 model 参数时按 id 过滤：llama.cpp 返回匹配模型的 n_ctx，不匹配返回 null', async () => {
    const baseUrl = await startMock(
      routedHandler({
        llama: {
          data: [
            { id: 'a', meta: { n_ctx: 4096 } },
            { id: 'b', meta: { n_ctx: 16384 } },
          ],
        },
        lmStudioStatus: 404,
      }),
    )
    expect(await probeMaxContext(baseUrl, { model: 'b' })).toBe(16384)
    expect(await probeMaxContext(baseUrl, { model: 'no-such' })).toBeNull()
  })

  it('带 model 参数时对 LM Studio 的 loaded_instances.id 同样生效', async () => {
    const baseUrl = await startMock(
      routedHandler({
        // llama.cpp 无 meta，迫使走 LM Studio 分支
        llama: { data: [{ id: 'lm1' }] },
        lmStudio: {
          models: [
            {
              id: 'lm1',
              loaded_instances: [
                { id: 'inst-a', config: { context_length: 2048 } },
                { id: 'inst-b', config: { context_length: 8192 } },
              ],
            },
          ],
        },
      }),
    )
    expect(await probeMaxContext(baseUrl, { model: 'inst-b' })).toBe(8192)
    expect(await probeMaxContext(baseUrl, { model: 'inst-x' })).toBeNull()
  })

  it('apiKey 非空时请求头带 Authorization: Bearer <apiKey>', async () => {
    let llamaAuth = ''
    let lmStudioAuth = ''
    const baseUrl = await startMock((req, res) => {
      const path = req.url ?? ''
      if (path === '/v1/models') {
        llamaAuth = req.headers.authorization ?? ''
        json(res, { data: [{ id: 'm1', meta: { n_ctx: 8192 } }] })
        return
      }
      if (path === '/api/v1/models') {
        lmStudioAuth = req.headers.authorization ?? ''
        json(res, { models: [{ id: 'm1', loaded_instances: [{ id: 'i1', config: { context_length: 8192 } }] }] })
        return
      }
      json(res, {}, 404)
    })
    await probeMaxContext(baseUrl, { apiKey: 'sk-test-123' })
    // llama.cpp 先成功，LM Studio 兜底请求可能不会发出；两个端点任一被请求时都应带鉴权头
    expect(llamaAuth).toBe('Bearer sk-test-123')
    expect(lmStudioAuth === '' || lmStudioAuth === 'Bearer sk-test-123').toBe(true)
  })

  it('无 apiKey 时不带 Authorization 头', async () => {
    let captured: Record<string, string | undefined> = {}
    const baseUrl = await startMock((req, res) => {
      const path = req.url ?? ''
      captured[path] = req.headers.authorization
      if (path === '/v1/models') {
        json(res, { data: [{ id: 'm1', meta: { n_ctx: 4096 } }] })
        return
      }
      if (path === '/api/v1/models') {
        json(res, { models: [{ id: 'm1', loaded_instances: [{ id: 'i1', config: { context_length: 4096 } }] }] })
        return
      }
      json(res, {}, 404)
    })
    await probeMaxContext(baseUrl)
    expect(captured['/v1/models']).toBeUndefined()
    expect(captured['/api/v1/models'] === undefined || captured['/api/v1/models'] === '').toBe(true)
  })

  it('上游响应超时 → 返回 null（不抛错）', async () => {
    const baseUrl = await startMock((_req, res) => {
      // 延迟远大于 timeoutMs，触发 axios 超时
      setTimeout(() => json(res, { data: [{ id: 'm1', meta: { n_ctx: 8192 } }] }), 500)
    })
    const result = await probeMaxContext(baseUrl, { timeoutMs: 50 })
    expect(result).toBeNull()
  })

  it('网络错误（连接被拒）→ 返回 null（不抛错）', async () => {
    // 127.0.0.1:1 无服务监听 → ECONNREFUSED
    const result = await probeMaxContext('http://127.0.0.1:1/v1')
    expect(result).toBeNull()
  })

  it('非法 baseUrl → 返回 null（不抛错）', async () => {
    const result = await probeMaxContext('not-a-url')
    expect(result).toBeNull()
  })
})

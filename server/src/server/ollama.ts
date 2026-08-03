// Ollama 兼容下游的 HTTP 服务模块：/api/tags 与 /api/chat
// 职责：模型列表（返回下游别名）、非流式/流式转发（OpenAI 上游 → Ollama 响应形状）、顺序回退、尝试计数
// 请求体由装配层（T19）注入 express.json 解析；本模块不做体校验，一律转发给 T13 转换器
// 只实现 /api/chat 与 /api/tags；/api/show、/api/generate、/api/embed、/api/create 明确不实现
import type { Express, Request, Response } from 'express'
import type { Readable, Writable } from 'node:stream'
import type { ConfigStore } from '../config/store.js'
import { convertModelsList } from '../converters/openai-to-ollama-models.js'
import { convertChatRequest } from '../converters/openai-to-ollama-request.js'
import { convertChatResponse, type OllamaChatResponse } from '../converters/openai-to-ollama-response.js'
import { createOpenAIToOllamaStream } from '../converters/openai-to-ollama-stream.js'
import { ModelNotFoundError } from '../router/errors.js'
import { executeWithFallback, isFallbackableAxiosError } from '../router/fallback.js'
import { Router } from '../router/index.js'
import type { LoadBalancer, SessionStoreLike } from '../router/load-balancer.js'
import { extractSessionKey } from '../session/key.js'
import type { OpenAIUpstreamClient, UpstreamChatRequest } from '../upstream/openai.js'

// 依赖注入集合：由装配层（T19）构造后传入，形状与 openai.ts（T12）保持一致
export interface OllamaDeps {
  store: ConfigStore
  getUpstreamClient: (id: string) => OpenAIUpstreamClient | undefined
  // 兼容字段：处理器按请求用 store.get() 重建路由器（rebuild-per-call），
  // 保证配置变更即时生效、无过期引用；此字段保留以兼容装配层注入
  router: Router
  loadBalancer: LoadBalancer
  onAttempt: (info: { upstreamId: string; ok: boolean; durationMs: number; status?: number }) => void
  // 可选：会话亲和存储，用于请求回退成功后把会话粘附改绑到实际成功上游；未注入则跳过改绑
  sessionStore?: SessionStoreLike
}

// 流式成功结果：转换后的 Ollama NDJSON 流 + 拆线函数
interface StreamSuccess {
  ollamaStream: Readable
  abort: () => void
}

/**
 * 注册 Ollama 兼容下游路由（挂到传入的 Express 应用上）：
 * - GET /api/tags：返回下游别名列表（downstreamModels 的 key，转成 Ollama 形状）
 * - POST /api/chat：非流式/流式转发（OpenAI 上游 → Ollama 响应形状）+ 顺序回退
 */
export function registerOllamaRoutes(app: Express, deps: OllamaDeps): void {
  const { store, getUpstreamClient, loadBalancer, onAttempt } = deps

  // 按请求重建路由器：直接取 store 最新配置，避免订阅时序造成过期引用
  const buildRouter = (): Router => new Router(store.get())

  // Express 5.2 未提供 req.signal（官方类型亦无此字段），
  // 用 AbortController + res 'close' 事件自建等价信号：客户端断开即中止上游请求。
  // 注意不能用 req 'close'：该事件在请求体被完整消费后就触发（与连接断开无关），会误中止
  const createRequestSignal = (res: Response): AbortSignal => {
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    return controller.signal
  }

  // 每次尝试后回调统计钩子（成功/失败都计一次，附带毫秒耗时与可选状态码）
  const reportAttempt = (upstreamId: string, ok: boolean, startedAt: bigint, status?: number): void => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    const info: { upstreamId: string; ok: boolean; durationMs: number; status?: number } = { upstreamId, ok, durationMs }
    if (status !== undefined) {
      info.status = status
    }
    onAttempt(info)
  }

  // 从错误中提取 HTTP 状态码（axios 响应错误 / 直接挂 status 的错误），无则 undefined
  const extractErrorStatus = (err: unknown): number | undefined => {
    if (!err || typeof err !== 'object') {
      return undefined
    }
    const e = err as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown }
    const status = e.response?.status ?? e.status ?? e.statusCode
    return typeof status === 'number' ? status : undefined
  }

  // 非流式转发：Ollama 形状请求 → OpenAI 上游 → 转回 Ollama 响应形状；全部候选失败返回 502
  const handleNonStream = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    // 未知模型别名在此抛 ModelNotFoundError，由外层 catch 转 404
    const candidates = buildRouter().resolve(model)
    // 提取会话键（header X-OpenWebUI-Chat-Id 优先，缺省内容前缀 hash）：
    // 有会话键 → 会话亲和路由粘附同一上游；无 → ctx 缺省 sessionKey，走轮询兜底
    const session = extractSessionKey(req, body)
    const ctx = {
      downstreamModel: model,
      sessionKey: session !== undefined ? `${model}::${session.raw}` : undefined,
      client: session?.client,
    }
    const result = await executeWithFallback<OllamaChatResponse>(
      candidates,
      loadBalancer,
      ctx,
      async (candidate) => {
        const attemptStart = process.hrtime.bigint()
        const client = getUpstreamClient(candidate.upstreamId)
        if (!client) {
          reportAttempt(candidate.upstreamId, false, attemptStart)
          // 客户端缺失（防御性，如配置刚删除）：可回退，尝试下一个候选
          return { ok: false, error: new Error('upstream_client_missing'), fallbackable: true }
        }
        try {
          // 下游 Ollama 形状请求 → OpenAI 请求（模型名替换为上游侧名称）→ 调用上游
          const ollamaReq = convertChatRequest({ ...body, model: candidate.model })
          // OllamaChatRequest 结构是 UpstreamChatRequest 的子集（缺索引签名），此处收窄到上游客户端签名
          const openaiResp = await client.chatCompletion(ollamaReq as unknown as UpstreamChatRequest, { signal })
          // OpenAI 响应 → Ollama 非流式响应（model 字段回填下游别名）
          const ollamaResp = convertChatResponse(openaiResp, model)
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: ollamaResp }
        } catch (err) {
          reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
          return { ok: false, error: err, fallbackable: isFallbackableAxiosError(err) }
        }
      },
      (candidate) => {
        // 回退成功后实际成功上游 ≠ 首选时，把会话粘附改绑到成功上游
        if (ctx.sessionKey !== undefined) {
          deps.sessionStore?.rebind(ctx.sessionKey, candidate.upstreamId, candidate.model)
        }
      },
    )
    if (result.ok && result.value) {
      res.status(200).json(result.value)
      return
    }
    // 全部候选失败：502，附带最后一次尝试的错误代号（若有）
    const lastEntry = result.attemptLog[result.attemptLog.length - 1]
    res.status(502).json(
      lastEntry.errorCode !== undefined ? { error: 'no_upstream', code: lastEntry.errorCode } : { error: 'no_upstream' },
    )
  }

  // 流式转发：先决议候选（失败可回退），成功后再设 NDJSON 头并接管转换流
  const handleStream = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const candidates = buildRouter().resolve(model)
    const session = extractSessionKey(req, body)
    const ctx = {
      downstreamModel: model,
      sessionKey: session !== undefined ? `${model}::${session.raw}` : undefined,
      client: session?.client,
    }
    const result = await executeWithFallback<StreamSuccess>(
      candidates,
      loadBalancer,
      ctx,
      async (candidate) => {
        const attemptStart = process.hrtime.bigint()
        const client = getUpstreamClient(candidate.upstreamId)
        if (!client) {
          reportAttempt(candidate.upstreamId, false, attemptStart)
          return { ok: false, error: new Error('upstream_client_missing'), fallbackable: true }
        }
        try {
          const ollamaReq = convertChatRequest({ ...body, model: candidate.model })
          const { stream, abort, connectError } = client.chatCompletionStream(ollamaReq as unknown as UpstreamChatRequest, {
            signal,
            includeUsage: true,
          })
          // 等待连接阶段结果：成功（null）→ 转换流；失败（Error）→ 可回退下一个候选
          // 必须 await：axios 流式调用是后台 promise，try/catch 抓不到它的 reject
          const connectErr = await connectError
          if (connectErr) {
            // 主动挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
            // （实际错误已通过 connectError 上报，调用方要走回退路径）
            stream.on('error', () => {})
            reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(connectErr))
            return { ok: false, error: connectErr, fallbackable: isFallbackableAxiosError(connectErr) }
          }
          // 转换器只负责挂接上游错误监听；必须由调用方显式 pipe，否则读取侧永不结束
          const ollamaStream = createOpenAIToOllamaStream(stream, model)
          stream.pipe(ollamaStream as unknown as Writable)
          reportAttempt(candidate.upstreamId, true, attemptStart)
          return { ok: true, value: { ollamaStream, abort } }
        } catch (err) {
          reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
          return { ok: false, error: err, fallbackable: isFallbackableAxiosError(err) }
        }
      },
      (candidate) => {
        // 回退成功后实际成功上游 ≠ 首选时，把会话粘附改绑到成功上游
        if (ctx.sessionKey !== undefined) {
          deps.sessionStore?.rebind(ctx.sessionKey, candidate.upstreamId, candidate.model)
        }
      },
    )
    if (!result.ok || !result.value) {
      res.status(502).json({ error: 'no_upstream' })
      return
    }
    const { ollamaStream, abort } = result.value
    // NDJSON 响应头必须在首字节之前设置
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()
    // 下游断开连接（客户端取消/超时）→ 拆掉上游连接，避免资源泄漏。
    // 用 res 'close' 而非 req 'close'（后者在请求体消费完后即触发，与断开无关）
    res.on('close', () => {
      abort()
    })
    // 转换流异常（上游传输错误已由转换器转成 NDJSON error 行，正常路径不触发）→ 结束响应
    ollamaStream.on('error', () => {
      if (!res.destroyed) {
        res.end()
      }
    })
    ollamaStream.pipe(res)
  }

  // Ollama 生态客户端连接探测端点：返回与 Ollama 兼容的版本号（如 Open WebUI 发起的首步探测）
  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ version: '0.5.12' })
  })

  // 模型列表：返回下游别名列表（downstreamModels 的 key），
  // 与聊天接口可识别的模型名保持一致，不再从上游拉取
  app.get('/api/tags', (_req: Request, res: Response) => {
    const config = store.get()
    const data = Object.keys(config.downstreamModels).map((id) => ({ id }))
    const converted = convertModelsList({ data })
    res.json(converted)
  })

  // 聊天：非流式与流式两条路径，共用回退逻辑；n > 1 先于一切检查拒绝
  app.post('/api/chat', async (req: Request, res: Response) => {
    try {
      // 请求体原样透传，不做校验；仅提取路由所需的模型名
      const body = req.body as Record<string, unknown>
      // Ollama 转换器不支持 n > 1（多条候选回答无对应实现）：先于模型解析直接拒绝
      const n = body.n
      if (typeof n === 'number' && n > 1) {
        res.status(400).json({ error: 'n_not_supported', message: 'Ollama converter does not support n > 1' })
        return
      }
      const model = typeof body.model === 'string' ? body.model : ''
      const signal = createRequestSignal(res)
      if (body.stream === true) {
        await handleStream(req, res, body, model, signal)
        return
      }
      await handleNonStream(req, res, body, model, signal)
    } catch (err) {
      // 未知模型别名 → 404；其余异常（如候选为空）→ 502
      if (err instanceof ModelNotFoundError) {
        res.status(404).json({ error: 'model_not_found' })
        return
      }
      res.status(502).json({ error: 'no_upstream' })
    }
  })
}

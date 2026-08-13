// OpenAI 兼容下游的 HTTP 服务模块：/v1/models、/v1/chat/completions、/v1/embeddings 与 /v1/rerank
// 职责：模型列表（返回下游别名）、非流式/流式透传、文本嵌入/重排序透传、按候选顺序回退、每次尝试计数
// 请求体解析（express.json 10mb）由装配层 T19 注入；请求体本身原样透传，不做校验
import type { Express, Request, Response } from 'express'
import type { Readable, Writable } from 'node:stream'
import type { ConfigStore } from '../config/store.js'
import { responsesRequestToChat, responsesToChatMessages } from '../converters/responses-request.js'
import { chatResponseToResponses } from '../converters/responses-response.js'
import { createResponsesStream } from '../converters/responses-stream.js'
import type { ResponsesRequest } from '../converters/responses-types.js'
import { ModelNotFoundError } from '../router/errors.js'
import { executeWithFallback, isFallbackableAxiosError } from '../router/fallback.js'
import { Router } from '../router/index.js'
import type { LoadBalancer, SessionStoreLike } from '../router/load-balancer.js'
import { buildUpstreamSessionHeaders, extractSessionKey } from '../session/key.js'
import type {
  OpenAIUpstreamClient,
  UpstreamChatRequest,
  UpstreamEmbeddingsRequest,
  UpstreamRerankRequest,
  UpstreamResponsesRequest,
} from '../upstream/openai.js'
import { buildAliasMetaMap } from './model-meta.js'

// 依赖注入集合：由装配层（T19）构造后传入
export interface OpenAIDeps {
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

// 非流式成功响应的包络：上游客户端只暴露响应体（axios 非 2xx 即抛错），status 恒为 2xx
interface ChatSuccess {
  status: number
  headers: Record<string, string>
  data: unknown
}

// 流式成功结果：上游 SSE 流 + 拆线函数
interface StreamSuccess {
  stream: Readable
  abort: () => void
}

/**
 * 注册 OpenAI 兼容下游路由（挂到传入的 Express 应用上）：
 * - GET /v1/models：返回下游别名列表（downstreamModels 的 key）
 * - POST /v1/chat/completions：非流式/流式透传 + 顺序回退
 * - POST /v1/embeddings：文本嵌入非流式透传 + 顺序回退（上游 404 视为不支持，可回退）
 * - POST /rerank 与 POST /v1/rerank：文本重排序非流式透传 + 顺序回退（上游 404 视为不支持，
 *   可回退；/v1/rerank 为 /rerank 的同义路径，两路径共享同一 handler）
 */
export function registerOpenAIRoutes(app: Express, deps: OpenAIDeps): void {
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

  // 非流式透传：改写模型名 → 逐个候选尝试 → 成功即回写；全部失败返回 502
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
    // 透传给上游的会话头：原始请求带 x-session-id 则原样转发，否则用计算出的 sessionId 补充
    const sessionHeaders = buildUpstreamSessionHeaders(req, session)
    const ctx = {
      downstreamModel: model,
      sessionKey: session !== undefined ? `${model}::${session.raw}` : undefined,
      client: session?.client,
    }
    const result = await executeWithFallback<ChatSuccess>(
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
        // 改写请求体：模型名换成上游侧名称，强制非流式
        body.model = candidate.model
        body.stream = false
        try {
          const data = await client.chatCompletion(body as UpstreamChatRequest, { signal, headers: sessionHeaders })
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: { status: 200, headers: {}, data } }
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
      res.status(result.value.status).json(result.value.data)
      return
    }
    // 全部候选失败：502，附带最后一次尝试的错误代号（若有）
    const lastEntry = result.attemptLog[result.attemptLog.length - 1]
    res.status(502).json(
      lastEntry.errorCode !== undefined ? { error: 'no_upstream', code: lastEntry.errorCode } : { error: 'no_upstream' },
    )
  }

  // 流式透传：先决议候选（失败可回退），成功后再设 SSE 头并接管上游流
  const handleStream = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const candidates = buildRouter().resolve(model)
    const session = extractSessionKey(req, body)
    // 透传给上游的会话头：原始请求带 x-session-id 则原样转发，否则用计算出的 sessionId 补充
    const sessionHeaders = buildUpstreamSessionHeaders(req, session)
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
        // 改写请求体：模型名换成上游侧名称，强制流式（includeUsage 让上游补发 usage 块）
        body.model = candidate.model
        body.stream = true

        try {
          const { stream, abort, connectError } = client.chatCompletionStream(body as UpstreamChatRequest, {
            signal,
            includeUsage: true,
            headers: sessionHeaders,
          })
          // 等待连接阶段结果：成功（null）→ 把流交给调用方；失败（Error）→ 可回退下一个候选
          // 必须 await：axios 流式调用是后台 promise，try/catch 抓不到它的 reject
          const connectErr = await connectError
          if (connectErr) {
            // 主动挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
            // （实际错误已通过 connectError 上报，调用方要走回退路径）
            stream.on('error', () => {})
            reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(connectErr))
            return { ok: false, error: connectErr, fallbackable: isFallbackableAxiosError(connectErr) }
          }
          reportAttempt(candidate.upstreamId, true, attemptStart)
          return { ok: true, value: { stream, abort } }
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
    const { stream, abort } = result.value
    // SSE 响应头必须在首字节之前设置
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    // 下游断开连接（客户端取消/超时）→ 拆掉上游连接，避免资源泄漏。
    // 用 res 'close' 而非 req 'close'（后者在请求体消费完后即触发，与断开无关）
    res.on('close', () => {
      abort()
    })
    // 上游流异常 → 结束响应（SSE 半关闭），不崩溃进程
    stream.on('error', () => {
      if (!res.destroyed) {
        res.end()
      }
    })
    stream.pipe(res)
  }

  // Responses API（POST /v1/responses）：非流式/流式两条路径，结构对齐 chat 处理器
  // 每条路径内部按配置 responsesApi 分流：'native' → 请求体原样透传（仅改写 model 与强制 stream），
  // 响应/事件流原样回转；缺省/convert → 网关边界转换：
  // responses 请求 → chat 请求（responsesRequestToChat）走 chatCompletion，
  // 响应回转：chat 非流式响应 → responses 对象 / chat SSE 流 → responses SSE 事件流
  const handleResponses = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    // 未知模型别名在此抛 ModelNotFoundError，由外层 catch 转 404
    const candidates = buildRouter().resolve(model)
    // responses 请求体无 messages 字段（结构为 { model, input, instructions }），
    // 先归一化为 chat messages 形状再提取会话键：header 优先逻辑不受影响（header 存在直接返回），
    // 无 header 时用归一化后的内容前缀 hash——与 chat 的「messages 前 2 条」语义一致
    // （responses 前 2 条 = instructions + 首条 input），跨协议同内容可匹配同一会话
    const session = extractSessionKey(req, { messages: responsesToChatMessages(body as ResponsesRequest) })
    // 透传给上游的会话头：原始请求带 x-session-id 则原样转发，否则用计算出的 sessionId 补充
    const sessionHeaders = buildUpstreamSessionHeaders(req, session)
    const ctx = {
      downstreamModel: model,
      sessionKey: session !== undefined ? `${model}::${session.raw}` : undefined,
      client: session?.client,
    }

    // ---------- 流式分支：chat SSE → responses SSE 事件流 ----------
    if (body.stream === true) {
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
          // 按配置分流：mode = upstreamCfg?.responsesApi ?? 'convert'（缺省 convert，防御性保留 ??）
          // native → 原生透传 /v1/responses；convert/未配置 → 转换路径（responses → chat）
          const upstreamCfg = store.get().upstreams.find((u) => u.id === candidate.upstreamId)
          const mode = upstreamCfg?.responsesApi ?? 'convert'
          // ---------- response（原生透传）：请求体原样（仅改写 model）+ 强制流式，响应事件原样 pipe ----------
          if (mode === 'native') {
            try {
              const { stream, abort, connectError } = client.responsesCompletionStream(
                { ...body, model: candidate.model, stream: true } as UpstreamResponsesRequest,
                { signal, headers: sessionHeaders },
              )
              // 等待连接阶段结果：成功（null）→ 把流交给调用方；失败（Error）→ 可回退下一个候选
              // 必须 await：axios 流式调用是后台 promise，try/catch 抓不到它的 reject
              const connectErr = await connectError
              if (connectErr) {
                // 主动挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
                // （实际错误已通过 connectError 上报，调用方要走回退路径）
                stream.on('error', () => {})
                reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(connectErr))
                // 决策 6/7：透传 404 → 视为该上游实际不支持 → 可回退；其余沿用 isFallbackableAxiosError
                return {
                  ok: false,
                  error: connectErr,
                  fallbackable: isFallbackableAxiosError(connectErr) || extractErrorStatus(connectErr) === 404,
                }
              }
              reportAttempt(candidate.upstreamId, true, attemptStart)
              return { ok: true, value: { stream, abort } }
            } catch (err) {
              reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
              return {
                ok: false,
                error: err,
                fallbackable: isFallbackableAxiosError(err) || extractErrorStatus(err) === 404,
              }
            }
          }
          // ---------- response→completions（转换）：responses → chat，chat SSE 流 → responses SSE 事件流 ----------
          // 转换发生在候选内：成功返回的 stream 已是 responses 事件流，输出管道对原生/转换一视同仁
          const chatReq = responsesRequestToChat(body as ResponsesRequest)
          chatReq.model = candidate.model
          chatReq.stream = true
          try {
            const { stream, abort, connectError } = client.chatCompletionStream(chatReq, {
              signal,
              includeUsage: true,
              headers: sessionHeaders,
            })
            // 等待连接阶段结果：成功（null）→ 把流交给调用方；失败（Error）→ 可回退下一个候选
            // 必须 await：axios 流式调用是后台 promise，try/catch 抓不到它的 reject
            const connectErr = await connectError
            if (connectErr) {
              // 主动挂空操作监听器，避免被丢弃的流产生 unhandled error 事件
              // （实际错误已通过 connectError 上报，调用方要走回退路径）
              stream.on('error', () => {})
              reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(connectErr))
              return { ok: false, error: connectErr, fallbackable: isFallbackableAxiosError(connectErr) }
            }
            // chat SSE 流 → responses SSE 事件流（转换器内部挂接上游 error 监听）
            const responsesStream = createResponsesStream(stream, model)
            stream.pipe(responsesStream as unknown as Writable)
            reportAttempt(candidate.upstreamId, true, attemptStart)
            return { ok: true, value: { stream: responsesStream, abort } }
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
      const { stream, abort } = result.value
      // SSE 响应头必须在首字节之前设置（原生透传流与转换流共用同一输出管道，直接 pipe）
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      // 下游断开连接（客户端取消/超时）→ 拆掉上游连接，避免资源泄漏。
      // 用 res 'close' 而非 req 'close'（后者在请求体消费完后即触发，与断开无关）
      res.on('close', () => {
        abort()
      })
      // 上游流异常 → 结束响应（SSE 半关闭），不崩溃进程
      stream.on('error', () => {
        if (!res.destroyed) {
          res.end()
        }
      })
      stream.pipe(res)
      return
    }

    // ---------- 非流式分支：chat 响应 → responses 响应对象 ----------
    const result = await executeWithFallback<ChatSuccess>(
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
        // 按配置分流：mode = upstreamCfg?.responsesApi ?? 'convert'（缺省 convert，防御性保留 ??）
        // native → 原生透传 /v1/responses；convert/未配置 → 转换路径（responses → chat）
        const upstreamCfg = store.get().upstreams.find((u) => u.id === candidate.upstreamId)
        const mode = upstreamCfg?.responsesApi ?? 'convert'
        // ---------- response（原生透传）：请求体原样（仅改写 model）+ 强制非流式，响应 JSON 原样返回 ----------
        if (mode === 'native') {
          try {
            const data = await client.responsesCompletion(
              { ...body, model: candidate.model, stream: false } as UpstreamResponsesRequest,
              { signal, headers: sessionHeaders },
            )
            reportAttempt(candidate.upstreamId, true, attemptStart, 200)
            return { ok: true, value: { status: 200, headers: {}, data } }
          } catch (err) {
            reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
            // 决策 6/7：透传 404 → 视为该上游实际不支持 → 可回退；其余沿用 isFallbackableAxiosError
            return {
              ok: false,
              error: err,
              fallbackable: isFallbackableAxiosError(err) || extractErrorStatus(err) === 404,
            }
          }
        }
        // ---------- response→completions（转换）：responses → chat，chat 响应 → responses 响应对象 ----------
        const chatReq = responsesRequestToChat(body as ResponsesRequest)
        chatReq.model = candidate.model
        chatReq.stream = false
        try {
          const data = await client.chatCompletion(chatReq, { signal, headers: sessionHeaders })
          // chat 响应 → responses 响应对象（model 用下游别名，与 /v1/chat/completions 一致）
          const responsesBody = chatResponseToResponses(data, model)
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: { status: 200, headers: {}, data: responsesBody } }
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
      res.status(result.value.status).json(result.value.data)
      return
    }
    // 全部候选失败：502，附带最后一次尝试的错误代号（若有）
    const lastEntry = result.attemptLog[result.attemptLog.length - 1]
    res.status(502).json(
      lastEntry.errorCode !== undefined ? { error: 'no_upstream', code: lastEntry.errorCode } : { error: 'no_upstream' },
    )
  }

  // 文本嵌入透传（POST /v1/embeddings）：非流式透传，结构逐行对齐 handleNonStream
  // 刻意不调用 extractSessionKey：embeddings 无多轮/缓存复用语义，不产生会话粘附、不写 sessions 表；
  // 即使请求带 X-OpenWebUI-Chat-Id / X-Session-Id 头也一律不提取（ctx 不含 sessionKey/client 字段）
  const handleEmbeddings = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    // 未知模型别名在此抛 ModelNotFoundError，由外层 catch 转 404
    const candidates = buildRouter().resolve(model)
    // ctx 缺省 sessionKey/client：无会话键 → 走轮询兜底，会话亲和均衡器也不会 bind/touch/rebind
    const ctx = { downstreamModel: model, sessionKey: undefined, client: undefined }
    // 省略第 5 个 onSuccess 参数：无会话键，无需 rebind
    const result = await executeWithFallback<ChatSuccess>(
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
        // 改写请求体：模型名换成上游侧名称；其余字段（input/encoding_format/dimensions 等）原样透传，
        // 不强制 stream（embeddings 协议无 stream 概念）
        body.model = candidate.model
        try {
          const data = await client.createEmbedding(body as UpstreamEmbeddingsRequest, { signal })
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: { status: 200, headers: {}, data } }
        } catch (err) {
          reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
          // 决策 6/7 镜像（responses 透传分支）：上游 404 → 视为该上游不支持 embeddings → 可回退；
          // 其余沿用 isFallbackableAxiosError（网络/超时/429/5xx 可回退，其它 4xx 立即中断）
          return {
            ok: false,
            error: err,
            fallbackable: isFallbackableAxiosError(err) || extractErrorStatus(err) === 404,
          }
        }
      },
    )
    if (result.ok && result.value) {
      res.status(result.value.status).json(result.value.data)
      return
    }
    // 全部候选失败：502，附带最后一次尝试的错误代号（若有）
    const lastEntry = result.attemptLog[result.attemptLog.length - 1]
    res.status(502).json(
      lastEntry.errorCode !== undefined ? { error: 'no_upstream', code: lastEntry.errorCode } : { error: 'no_upstream' },
    )
  }

  // 文本重排序透传（POST /rerank 与 /v1/rerank）：非流式透传，结构逐行对齐 handleEmbeddings
  // 刻意不调用 extractSessionKey：rerank 为一次性无状态调用，不产生会话粘附、不写 sessions 表
  // （与 embeddings 一致）；即使请求带 X-OpenWebUI-Chat-Id / X-Session-Id 头也一律不提取
  // （ctx 不含 sessionKey/client 字段）
  const handleRerank = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    // 未知模型别名在此抛 ModelNotFoundError，由外层 catch 转 404
    const candidates = buildRouter().resolve(model)
    // ctx 缺省 sessionKey/client：无会话键 → 走轮询兜底，会话亲和均衡器也不会 bind/touch/rebind
    const ctx = { downstreamModel: model, sessionKey: undefined, client: undefined }
    // 省略第 5 个 onSuccess 参数：无会话键，无需 rebind
    const result = await executeWithFallback<ChatSuccess>(
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
        // 改写请求体：模型名换成上游侧名称；其余字段（query/documents/top_n 等）原样透传，
        // 不强制 stream（rerank 协议无 stream 概念）
        body.model = candidate.model
        try {
          const data = await client.rerank(body as UpstreamRerankRequest, { signal })
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: { status: 200, headers: {}, data } }
        } catch (err) {
          reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
          // 决策 6/7 镜像（responses 透传分支）：上游 404 → 视为该上游不支持 rerank → 可回退；
          // 其余沿用 isFallbackableAxiosError（网络/超时/429/5xx 可回退，其它 4xx 立即中断）
          return {
            ok: false,
            error: err,
            fallbackable: isFallbackableAxiosError(err) || extractErrorStatus(err) === 404,
          }
        }
      },
    )
    if (result.ok && result.value) {
      res.status(result.value.status).json(result.value.data)
      return
    }
    // 全部候选失败：502，附带最后一次尝试的错误代号（若有）
    const lastEntry = result.attemptLog[result.attemptLog.length - 1]
    res.status(502).json(
      lastEntry.errorCode !== undefined ? { error: 'no_upstream', code: lastEntry.errorCode } : { error: 'no_upstream' },
    )
  }
  // 模型列表：返回下游别名列表（downstreamModels 的 key），
  // 与聊天接口可识别的模型名保持一致，不再从上游拉取；
  // 别名能聚合出候选 max_context_length 时附加 meta: { n_ctx: 最小值 }
  app.get('/v1/models', (_req: Request, res: Response) => {
    const config = store.get()
    const metaMap = buildAliasMetaMap(config)
    const data = Object.keys(config.downstreamModels).map((id) => {
      const entry: { id: string; object: string; owned_by: string; meta?: { n_ctx: number } } = {
        id,
        object: 'model',
        owned_by: 'llmproxy',
      }
      const meta = metaMap[id]
      // 仅当别名能聚合出 n_ctx 时附加 meta（capabilities 属 Ollama 侧字段，/v1/models 不输出）
      if (meta !== undefined && meta.n_ctx !== undefined) {
        entry.meta = { n_ctx: meta.n_ctx }
      }
      return entry
    })
    res.json({ object: 'list', data })
  })

  // 聊天补全：非流式与流式两条路径，共用回退逻辑
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      // 请求体原样透传，不做校验；仅提取路由所需的模型名
      const body = req.body as Record<string, unknown>
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

  // Responses API：非流式与流式两条路径，共用回退逻辑（与 /v1/chat/completions 并列）
  app.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      // 仅提取路由所需的模型名；请求体在边界转换为 chat 格式
      const body = req.body as Record<string, unknown>
      const model = typeof body.model === 'string' ? body.model : ''
      const signal = createRequestSignal(res)
      await handleResponses(req, res, body, model, signal)
    } catch (err) {
      // 未知模型别名 → 404；其余异常（如候选为空）→ 502（与 chat 接口一致）
      if (err instanceof ModelNotFoundError) {
        res.status(404).json({ error: 'model_not_found' })
        return
      }
      res.status(502).json({ error: 'no_upstream' })
    }
  })

  // 文本嵌入：非流式透传（embeddings 协议无 stream），与 /v1/responses 并列
  app.post('/v1/embeddings', async (req: Request, res: Response) => {
    try {
      // 请求体原样透传，不做校验；仅提取路由所需的模型名
      const body = req.body as Record<string, unknown>
      const model = typeof body.model === 'string' ? body.model : ''
      const signal = createRequestSignal(res)
      await handleEmbeddings(req, res, body, model, signal)
    } catch (err) {
      // 未知模型别名 → 404；其余异常（如候选为空）→ 502（与 chat 接口一致）
      if (err instanceof ModelNotFoundError) {
        res.status(404).json({ error: 'model_not_found' })
        return
      }
      res.status(502).json({ error: 'no_upstream' })
    }
  })

  // 文本重排序：非流式透传（rerank 协议无 stream），/rerank 与 /v1/rerank 同义，
  // 两路径共享同一 handler 与同一 catch 逻辑（与 /v1/embeddings 一致）
  const registerRerank = (path: string): void => {
    app.post(path, async (req: Request, res: Response) => {
      try {
        // 请求体原样透传，不做校验；仅提取路由所需的模型名
        const body = req.body as Record<string, unknown>
        const model = typeof body.model === 'string' ? body.model : ''
        const signal = createRequestSignal(res)
        await handleRerank(req, res, body, model, signal)
      } catch (err) {
        // 未知模型别名 → 404；其余异常（如候选为空）→ 502（与 chat 接口一致）
        if (err instanceof ModelNotFoundError) {
          res.status(404).json({ error: 'model_not_found' })
          return
        }
        res.status(502).json({ error: 'no_upstream' })
      }
    })
  }
  registerRerank('/rerank')
  registerRerank('/v1/rerank')
}

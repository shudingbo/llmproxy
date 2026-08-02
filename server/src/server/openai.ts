// OpenAI 兼容下游的 HTTP 服务模块：/v1/models 与 /v1/chat/completions
// 职责：模型列表聚合（带 60s 缓存）、非流式/流式透传、按候选顺序回退、每次尝试计数
// 请求体解析（express.json 10mb）由装配层 T19 注入；请求体本身原样透传，不做校验
import type { Express, Request, Response } from 'express'
import type { Readable } from 'node:stream'
import type { ConfigStore } from '../config/store.js'
import { ModelNotFoundError } from '../router/errors.js'
import { executeWithFallback, isFallbackableAxiosError } from '../router/fallback.js'
import { Router } from '../router/index.js'
import type { LoadBalancer } from '../router/load-balancer.js'
import type { OpenAIUpstreamClient, UpstreamChatRequest } from '../upstream/openai.js'

// 模型列表缓存的过期时间（毫秒）
const MODELS_CACHE_TTL_MS = 60_000

// 模型列表条目：id 必填，其余字段原样保留（按 id 去重合并）
export interface ModelEntry {
  id: string
  [key: string]: unknown
}

// 依赖注入集合：由装配层（T19）构造后传入
export interface OpenAIDeps {
  store: ConfigStore
  getUpstreamClient: (id: string) => OpenAIUpstreamClient | undefined
  // 兼容字段：处理器按请求用 store.get() 重建路由器（rebuild-per-call），
  // 保证配置变更即时生效、无过期引用；此字段保留以兼容装配层注入
  router: Router
  loadBalancer: LoadBalancer
  onAttempt: (info: { upstreamId: string; ok: boolean; durationMs: number; status?: number }) => void
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
 * - GET /v1/models：聚合全部上游模型列表，60s 缓存，配置变更立即失效
 * - POST /v1/chat/completions：非流式/流式透传 + 顺序回退
 */
export function registerOpenAIRoutes(app: Express, deps: OpenAIDeps): void {
  const { store, getUpstreamClient, loadBalancer, onAttempt } = deps

  // 模型列表缓存：上游 id → { fetchedAt, models }，60 秒后过期
  const modelsCache = new Map<string, { fetchedAt: number; models: ModelEntry[] }>()

  // 配置变更（管理端写入 / 文件监听重载）→ 立即失效模型缓存，
  // 新加入的上游下一次请求即被拉取（路由器按请求重建，天然最新）
  store.subscribe(() => {
    modelsCache.clear()
  })

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

  // 拉取单个上游的模型列表（60s 缓存；出错跳过，不拖垮整体列表）
  const fetchModels = async (client: OpenAIUpstreamClient, upstreamId: string): Promise<ModelEntry[] | undefined> => {
    const cached = modelsCache.get(upstreamId)
    const now = Date.now()
    if (cached !== undefined && now - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
      return cached.models
    }
    try {
      const models = await client.listModels()
      modelsCache.set(upstreamId, { fetchedAt: now, models })
      return models
    } catch {
      return undefined
    }
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
    const result = await executeWithFallback<ChatSuccess>(
      candidates,
      loadBalancer,
      { downstreamModel: model },
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
          const data = await client.chatCompletion(body as UpstreamChatRequest, { signal })
          reportAttempt(candidate.upstreamId, true, attemptStart, 200)
          return { ok: true, value: { status: 200, headers: {}, data } }
        } catch (err) {
          reportAttempt(candidate.upstreamId, false, attemptStart, extractErrorStatus(err))
          return { ok: false, error: err, fallbackable: isFallbackableAxiosError(err) }
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
    const result = await executeWithFallback<StreamSuccess>(
      candidates,
      loadBalancer,
      { downstreamModel: model },
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

  // 模型列表：聚合全部被下游模型引用的上游，按 id 去重合并
  app.get('/v1/models', async (_req: Request, res: Response) => {
    const config = store.get()
    // 收集下游模型映射引用的全部上游 id（Set 去重）
    const upstreamIds = new Set<string>()
    for (const candidates of Object.values(config.downstreamModels)) {
      for (const candidate of candidates) {
        upstreamIds.add(candidate.upstreamId)
      }
    }
    const byId = new Map<string, ModelEntry>()
    for (const upstreamId of upstreamIds) {
      const client = getUpstreamClient(upstreamId)
      if (!client) {
        continue // 客户端缺失（如配置刚删除）时跳过
      }
      const models = await fetchModels(client, upstreamId)
      if (!models) {
        continue // 单个上游拉取失败跳过，不拖垮整体列表
      }
      for (const model of models) {
        byId.set(model.id, model)
      }
    }
    res.json({ object: 'list', data: [...byId.values()] })
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
}

// 管理端 REST 接口：/admin/api/* 全部端点
// 职责：上游增删改查与连通性测试、下游模型映射替换、日志查询、统计、健康检查、配置查看与重载错误
// 无鉴权（由部署层防护）、无 CORS（开发期走 web/vite 代理）；apiKey 一律不落日志、响应中全部掩码
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import type { Express, Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { DownstreamModelSchema, UpstreamSchema, type UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { sweepLogsBefore } from '../logger/sweep.js'
import { LogStore } from '../logstore/index.js'
import { getLogDir } from '../paths.js'
import type { StatsCounter } from '../stats/counter.js'
import { SessionStore } from '../session/db.js'
import { probeMaxContext } from '../upstream/context.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { DOWNSTREAM_ENDPOINTS } from './downstreams.js'
import { resolveListen, type CliArgs } from './listen.js'
import { maskApiKey } from './admin-helpers.js'

// 依赖注入集合：由装配层（T19）构造后传入
export interface AdminDeps {
  store: ConfigStore
  getUpstreamClient: (id: string) => OpenAIUpstreamClient | undefined
  stats: StatsCounter
  // 会话粘附存储：列表/删除/清空/过期清理都由 SessionStore 提供，路由层不直接碰 SQLite
  sessionStore: SessionStore
  // 日志存储：/admin/api/logs 查询走 LogStore.query（SQLite），路由层不直接碰文件
  logStore: LogStore
  // 命令行 --host/--port：透传到 /admin/api/health，保证返回值与 app.listen 实际生效值一致
  cli?: CliArgs
}

// 日志查询参数（date 必填且必须是 YYYY-MM-DD；type 区分 app/api；level/keyword 可选）
// type 默认 app，向后兼容旧调用；查询走 LogStore.query（SQLite），按级别阈值 + 关键词过滤
// offset/limit 游标分页：time 倒序（最新在前）；offset 是"已跳过的匹配行数"，limit 默认 100 上限 500
interface LogQuery {
  date: string
  type: 'app' | 'api'
  level?: string
  keyword?: string
  offset: number
  limit: number
}

const LogQuerySchema: ZodType<LogQuery> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  type: z.enum(['app', 'api']).optional().default('app'),
  level: z.string().optional().default('info'),
  keyword: z.string().optional(),
  // query 参数均为字符串，用 coerce 转数字；int/min 校验不通过返回 400
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

// 会话粘附查询参数：client 精确匹配、keyword 模糊匹配 session_id/upstream_id（过滤由 SessionStore.list 实现）
// offset/limit 游标分页：最新（updated_at 倒序）在前，offset 默认 0，limit 默认 100 上限 500
interface SessionQuery {
  client?: string
  keyword?: string
  offset: number
  limit: number
}

const SessionQuerySchema: ZodType<SessionQuery> = z.object({
  client: z.string().optional(),
  keyword: z.string().optional(),
  // query 参数均为字符串，用 coerce 转数字；int/min/max 校验不通过返回 400
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

// log4js / pino 共同的级别数值映射（前端 Logs 视图契约）：trace=10 debug=20 info=30 warn=40 error=50 fatal=60
const LEVEL_NUMBERS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

// 版本号：从包根 package.json 惰性读取并缓存（读取失败兜底 'unknown'）
let cachedVersion: string | null = null
function getVersion(): string {
  if (cachedVersion === null) {
    try {
      const url = new URL('../../package.json', import.meta.url)
      const pkg = JSON.parse(readFileSync(url, 'utf-8')) as { version?: unknown }
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown'
    } catch {
      cachedVersion = 'unknown'
    }
  }
  return cachedVersion
}

// 从错误中提取可读代号：优先 err.code（如 ECONNREFUSED），缺省回退 HTTP 状态码字符串
const extractErrorCode = (err: unknown): string => {
  if (!err || typeof err !== 'object') {
    return 'unknown'
  }
  const e = err as { code?: unknown; response?: { status?: unknown }; status?: unknown; statusCode?: unknown }
  if (typeof e.code === 'string' && e.code !== '') {
    return e.code
  }
  const status = e.response?.status ?? e.status ?? e.statusCode
  if (typeof status === 'number') {
    return String(status)
  }
  return 'unknown'
}

// 本机首个非回环 IPv4（供通配监听时生成可访问的入口 URL）
function getLocalIPv4(): string | undefined {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return undefined
}

// 生成客户端可访问的入口 URL：通配监听（0.0.0.0 / ::）时用本机 IP，否则用监听 host
function resolvePublicBaseUrl(listen: { host: string; port: number }): string {
  const host =
    listen.host === '0.0.0.0' || listen.host === '::'
      ? (getLocalIPv4() ?? '127.0.0.1')
      : listen.host
  return `http://${host}:${listen.port}`
}

/**
 * 注册管理端路由（挂到传入的 Express 应用上）。
 * 假定装配层已注入 express.json（10mb）与请求日志中间件。
 */
export function registerAdminRoutes(app: Express, deps: AdminDeps): void {
  const { store, getUpstreamClient, stats, sessionStore, logStore, cli } = deps

  // 上游列表：apiKey 掩码后返回（仅展示用途，绝不回传明文）
  app.get('/admin/api/upstreams', (_req: Request, res: Response) => {
    res.json(store.get().upstreams.map((u) => ({ ...u, apiKey: maskApiKey(u.apiKey) })))
  })

  // 新增上游：zod 校验（缺省字段如 timeoutMs/disabled 由 schema 补齐），写盘来源标记 admin
  app.post('/admin/api/upstreams', (req: Request, res: Response) => {
    const parsed = UpstreamSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_upstream', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const config = store.get()
    if (config.upstreams.some((u) => u.id === parsed.data.id)) {
      res.status(400).json({ error: 'duplicate_id', id: parsed.data.id })
      return
    }
    store.set({ ...config, upstreams: [...config.upstreams, parsed.data] }, { source: 'admin' })
    res.status(201).json({ ...parsed.data, apiKey: maskApiKey(parsed.data.apiKey) })
  })

  // 部分更新上游：id 以路径为准（请求体中的 id 字段被忽略，防止改键导致下游引用悬空）
  app.put('/admin/api/upstreams/:id', (req: Request, res: Response) => {
    const config = store.get()
    const existing = config.upstreams.find((u) => u.id === req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'upstream_not_found', id: req.params.id })
      return
    }
    const patch = { ...(req.body as Record<string, unknown>) }
    delete patch.id
    const parsed = UpstreamSchema.safeParse({ ...existing, ...patch })
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_upstream', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    store.set(
      { ...config, upstreams: config.upstreams.map((u) => (u.id === req.params.id ? parsed.data : u)) },
      { source: 'admin' },
    )
    res.json({ ...parsed.data, apiKey: maskApiKey(parsed.data.apiKey) })
  })

  // 删除上游：同时级联清理下游模型别名中的候选（别名候选清空后整个别名删除）；最后一个上游拒绝删除
  app.delete('/admin/api/upstreams/:id', (req: Request, res: Response) => {
    const config = store.get()
    if (!config.upstreams.some((u) => u.id === req.params.id)) {
      res.status(404).json({ error: 'upstream_not_found', id: req.params.id })
      return
    }
    if (config.upstreams.length <= 1) {
      res.status(400).json({ error: 'last_upstream' })
      return
    }
    const upstreams = config.upstreams.filter((u) => u.id !== req.params.id)
    const downstreamModels: Record<string, UpstreamCandidate[]> = {}
    for (const [alias, candidates] of Object.entries(config.downstreamModels)) {
      const rest = candidates.filter((c) => c.upstreamId !== req.params.id)
      if (rest.length > 0) {
        downstreamModels[alias] = rest
      }
    }
    store.set({ ...config, upstreams, downstreamModels }, { source: 'admin' })
    res.json({ ok: true })
  })

  // 上游连通性测试：请求体可覆盖 baseUrl/apiKey（apiKey 允许为空串，Ollama 风格），否则用配置中的上游
  app.post('/admin/api/upstreams/:id/test', async (req: Request, res: Response) => {
    const config = store.get()
    const configured = config.upstreams.find((u) => u.id === req.params.id)
    const body = (req.body ?? {}) as Record<string, unknown>
    let client: OpenAIUpstreamClient
    if (typeof body.baseUrl === 'string') {
      // 覆盖模式：超时沿用已配置上游的值（无配置时 30s），apiKey 缺省为空
      client = new OpenAIUpstreamClient({
        baseUrl: body.baseUrl,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
        timeoutMs: configured?.timeoutMs ?? 30000,
      })
    } else {
      if (!configured) {
        res.status(404).json({ error: 'upstream_not_found', id: req.params.id })
        return
      }
      // 优先注入的客户端工厂，缺省用配置直接构建（Express 5 的 params 可能是 string[]，收敛为 string）
      client = getUpstreamClient(String(req.params.id)) ?? openaiClient(configured)
    }
    const startedAt = process.hrtime.bigint()
    try {
      const models = await client.listModels()
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      res.json({ ok: true, status: 200, latencyMs, modelCount: models.length })
    } catch (err) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      res.json({ ok: false, latencyMs, modelCount: 0, error: extractErrorCode(err) })
    }
  })

  // 候选模型上下文探测（llama.cpp / LM Studio）
  app.post('/admin/api/candidates/probe-context', async (req: Request, res: Response) => {
    const config = store.get()
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.upstreamId !== 'string' || body.upstreamId === '') {
      res.status(400).json({ error: 'invalid_request', field: 'upstreamId' })
      return
    }
    if (typeof body.model !== 'string' || body.model === '') {
      res.status(400).json({ error: 'invalid_request', field: 'model' })
      return
    }
    const configured = config.upstreams.find((u) => u.id === body.upstreamId)
    let baseUrl: string
    let apiKey = ''
    let timeoutMs = 5000
    if (configured) {
      baseUrl = configured.baseUrl
      apiKey = configured.apiKey
      timeoutMs = configured.timeoutMs ?? 5000
      if (typeof body.baseUrl === 'string' && body.baseUrl !== '') {
        baseUrl = body.baseUrl
      }
      if (typeof body.apiKey === 'string' && body.apiKey !== '') {
        apiKey = body.apiKey
      }
    } else {
      if (typeof body.baseUrl !== 'string' || body.baseUrl === '') {
        res.status(400).json({ error: 'invalid_request', field: 'baseUrl' })
        return
      }
      baseUrl = body.baseUrl
      apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
    }
    if (typeof body.timeoutMs === 'number' && body.timeoutMs > 0) {
      timeoutMs = body.timeoutMs
    }
    try {
      const maxContextLength = await probeMaxContext(baseUrl, {
        apiKey,
        timeoutMs,
        model: body.model,
      })
      if (maxContextLength === null) {
        // 探测不到：两端点均失败 / 无 n_ctx 值；网络错误也被 probeMaxContext 吞成 null，统一呈现为 context_not_found
        res.json({ ok: false, error: 'context_not_found' })
        return
      }
      res.json({ ok: true, max_context_length: maxContextLength })
    } catch (err) {
      // 防御分支：probeMaxContext 约定不抛错，真抛了按错误代号返回（未知代号回退 probe_failed）
      const code = extractErrorCode(err)
      res.json({ ok: false, error: code === 'unknown' ? 'probe_failed' : code })
    }
  })

  // 下游模型映射：原样返回（候选不含敏感字段）
  app.get('/admin/api/downstream-models', (_req: Request, res: Response) => {
    res.json(store.get().downstreamModels)
  })

  // 整体替换下游模型映射：zod 校验（每个别名至少 1 个候选），无效返回 400
  app.put('/admin/api/downstream-models', (req: Request, res: Response) => {
    const parsed = z.record(z.string(), DownstreamModelSchema).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_downstream_models', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const config = store.get()
    store.set({ ...config, downstreamModels: parsed.data }, { source: 'admin' })
    res.json(parsed.data)
  })

  // 日志查询：date 必填；type 区分 app/api；按级别阈值 + 关键词过滤；
  // 查询走 LogStore.query（SQLite，time 倒序最新在前），offset/limit 游标分页；hasMore 表示更早处是否还有匹配日志
  app.get('/admin/api/logs', (req: Request, res: Response) => {
    const parsed = LogQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { date, type, level, keyword, offset, limit } = parsed.data
    const levelValue = LEVEL_NUMBERS[level ?? 'info'] ?? 30
    // date（YYYY-MM-DD）→ 本地时区 [当日 00:00:00.000, 当日 23:59:59.999] epoch ms
    const dayStart = new Date(`${date}T00:00:00.000`).getTime()
    const dayEnd = new Date(`${date}T23:59:59.999`).getTime()
    try {
      const { rows, total } = logStore.query({
        type,
        from: dayStart,
        to: dayEnd,
        minLevel: levelValue,
        keyword: keyword?.trim() !== '' ? keyword : undefined,
        offset,
        limit,
      })
      // 行 → 前端兼容形状（snake_case → camelCase，缺省字段省略）
      const lines = rows.map((r) => ({
        level: r.level,
        time: r.time,
        msg: r.msg ?? undefined,
        category: r.category ?? undefined,
        requestId: r.request_id ?? undefined,
        method: r.method ?? undefined,
        url: r.url ?? undefined,
        status: r.status ?? undefined,
      }))
      res.json({ lines, type, offset, limit, total, hasMore: offset + lines.length < total, scanned: lines.length })
    } catch (err) {
      getLogger().warn({ err }, '日志查询失败')
      res.status(500).json({ error: 'log_read_failed' })
    }
  })

  // 手动清理日志：body { before?: number }（epoch ms，缺省 7 天前）；同时清理 DB（time < before）与文件（mtime < before）
  // before 非 number 或非法（NaN/Infinity）时宽松回退缺省；返回各自删除条数与生效的 before
  app.post('/admin/api/logs/cleanup', (req: Request, res: Response) => {
    const rawBefore = (req.body as { before?: unknown } | undefined)?.before
    const before =
      typeof rawBefore === 'number' && Number.isFinite(rawBefore) ? rawBefore : Date.now() - 7 * 24 * 60 * 60 * 1000
    try {
      const deleted = logStore.deleteBefore(before)
      const deletedFiles = sweepLogsBefore(getLogDir(), before)
      res.json({ deleted, deletedFiles, before })
    } catch (err) {
      getLogger().warn({ err }, '手动清理日志失败')
      res.status(500).json({ error: 'log_cleanup_failed' })
    }
  })

  // 统计：窗口起点 + 全量汇总 + 按上游聚合明细
  app.get('/admin/api/stats', (_req: Request, res: Response) => {
    const snap = stats.snapshot()
    let requests = 0
    let errors = 0
    let totalLatencyMs = 0
    const perUpstream: Array<{
      upstreamId: string
      requests: number
      errors: number
      avgLatencyMs: number
      totalLatencyMs: number
    }> = []
    for (const [upstreamId, s] of snap.perUpstream) {
      requests += s.requests
      errors += s.errors
      totalLatencyMs += s.totalLatencyMs
      perUpstream.push({
        upstreamId,
        requests: s.requests,
        errors: s.errors,
        avgLatencyMs: s.avgLatencyMs,
        totalLatencyMs: s.totalLatencyMs,
      })
    }
    res.json({
      since: snap.since,
      totals: { requests, errors, avgLatencyMs: requests > 0 ? totalLatencyMs / requests : 0 },
      perUpstream,
    })
  })

  // 会话粘附映射分页列表：updated_at 倒序（由 SessionStore.list 实现）；client 精确匹配、keyword 模糊匹配
  // session_id/upstream_id；offset/limit 游标分页，total 为满足筛选条件的总数（不含分页）
  app.get('/admin/api/sessions', (req: Request, res: Response) => {
    const parsed = SessionQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { client, keyword, offset, limit } = parsed.data
    try {
      const { rows, total } = sessionStore.list({ offset, limit, client, keyword })
      res.json({ rows, total })
    } catch (err) {
      getLogger().warn({ err }, '会话粘附列表查询失败')
      res.status(500).json({ error: 'session_list_failed' })
    }
  })

  // 删除单条会话粘附（解绑）：下次请求重新选上游；幂等，不存在也返回 200 { deleted: false }
  app.delete('/admin/api/sessions/:sessionKey', (req: Request, res: Response) => {
    const sessionKey = String(req.params.sessionKey)
    try {
      res.json({ deleted: sessionStore.delete(sessionKey) })
    } catch (err) {
      getLogger().warn({ err, sessionKey }, '会话粘附删除失败')
      res.status(500).json({ error: 'session_delete_failed' })
    }
  })

  // 清空全部会话粘附：返回删除条数
  app.delete('/admin/api/sessions', (_req: Request, res: Response) => {
    try {
      res.json({ deleted: sessionStore.clear() })
    } catch (err) {
      getLogger().warn({ err }, '会话粘附清空失败')
      res.status(500).json({ error: 'session_clear_failed' })
    }
  })

  // 立即手动清理过期会话：保留期从配置 routing.sessionAffinity.cleanupMaxAgeMs 读取（缺省 1 周）；
  // 0 表示会话永不过期（与 schema 语义一致），此时跳过清理
  app.post('/admin/api/sessions/cleanup', (_req: Request, res: Response) => {
    const maxAgeMs = store.get().routing?.sessionAffinity?.cleanupMaxAgeMs ?? 604800000
    if (maxAgeMs === 0) {
      res.json({ deleted: 0 })
      return
    }
    try {
      res.json({ deleted: sessionStore.cleanup(maxAgeMs) })
    } catch (err) {
      getLogger().warn({ err, maxAgeMs }, '会话粘附过期清理失败')
      res.status(500).json({ error: 'session_cleanup_failed' })
    }
  })

  // 健康检查：进程存活 + 版本 + 各上游健康状态（disabled → paused）
  // 附 downstreams：与启动日志同一份端点清单，供 web Dashboard 渲染下游 API 表
  // baseUrl / host / port / listenSource：当前进程实际生效的下行流入口（与 startServer 共用 resolveListen）
  app.get('/admin/api/health', (_req: Request, res: Response) => {
    const upstreams: Record<string, 'healthy' | 'paused'> = {}
    for (const u of store.get().upstreams) {
      upstreams[u.id] = u.disabled ? 'paused' : 'healthy'
    }
    const listen = resolveListen(store.get(), { cli })
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: getVersion(),
      upstreams,
      downstreams: DOWNSTREAM_ENDPOINTS,
      host: listen.host,
      port: listen.port,
      baseUrl: resolvePublicBaseUrl(listen),
      listenSource: listen.source,
    })
  })

  // 当前生效配置：apiKey 掩码后返回
  app.get('/admin/api/config', (_req: Request, res: Response) => {
    const config = store.get()
    res.json({ ...config, upstreams: config.upstreams.map((u) => ({ ...u, apiKey: maskApiKey(u.apiKey) })) })
  })

  // 最近一次外部重载错误（无则 null）
  app.get('/admin/api/config/reload-error', (_req: Request, res: Response) => {
    const err = store.getRecentReloadError()
    res.json({ error: err === null || err === undefined ? null : err instanceof Error ? err.message : String(err) })
  })
}

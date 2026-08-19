// 管理端 REST 接口：/admin/api/* 全部端点
// 职责：上游增删改查与连通性测试、下游模型映射替换、日志查询、统计、健康检查、配置查看/保存与重载错误
// 全局登录鉴权（白名单：/auth/login、/auth/salt、/auth/status、/auth/logout、/health），无 CORS（开发期走 web/vite 代理）；apiKey 一律不落日志、响应中全部掩码
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import type { Express, Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import type { Config } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import {
  ConfigSchema,
  DownstreamAliasGroupSchema,
  DownstreamModelEntrySchema,
  UpstreamSchema,
  type AdminAccount,
  type UpstreamCandidate,
} from '../config/schema.js'
import { normalizeDownstreamAliasEntry } from '../config/loader.js'
import { getLogger } from '../logger/index.js'
import { sweepLogsBefore } from '../logger/sweep.js'
import { LogStore } from '../logstore/index.js'
import { getLogDir } from '../paths.js'
import type { StatsCounter } from '../stats/counter.js'
import { SessionStore } from '../session/db.js'
import { probeMaxContext } from '../upstream/context.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { ApiKeyStore } from '../auth/db.js'
import { extractKeyPrefix, generateApiKey, hashApiKey } from '../auth/key.js'
import { AdminSessionStore } from '../auth/session-store.js'
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  clearSessionCookie,
  computePasswordHash,
  createAdminAuthMiddleware,
  generateSessionId,
  isTsWithinWindow,
  parseCookieValue,
  safeEqualHex,
  setSessionCookie,
} from '../auth/admin-auth.js'
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
  // API Key 鉴权存储：列表/CRUD 路由层不直接碰 SQLite，统一走 ApiKeyStore
  apiKeyStore: ApiKeyStore
  // 管理端会话存储：登录/登出/改密/账号 CRUD 统一走 AdminSessionStore
  adminSessionStore: AdminSessionStore
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

// API Key 列表查询参数：keyword 模糊匹配 name/key_prefix；includeDisabled=true 同时返回停用记录；
// offset/limit 游标分页，total 为满足筛选条件的总数（不含分页）
interface ApiKeyQuery {
  keyword?: string
  includeDisabled?: boolean
  offset: number
  limit: number
}

const ApiKeyQuerySchema: ZodType<ApiKeyQuery> = z.object({
  keyword: z.string().optional(),
  includeDisabled: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

// API Key 创建入参：name 必填（1-64 字符）；expiresAt 0 表示永不过期；其他值需 > now
const ApiKeyCreateSchema = z.object({
  name: z.string().min(1).max(64),
  expiresAt: z.number().int().min(0).default(0),
})

// API Key 更新入参：name / expiresAt / disabled 任意子集；未提供字段保留原值
const ApiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  expiresAt: z.number().int().min(0).optional(),
  disabled: z.boolean().optional(),
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
  const { store, getUpstreamClient, stats, sessionStore, logStore, apiKeyStore, adminSessionStore, cli } = deps

  // 管理端会话鉴权：全局挂载到 /admin/api，白名单外的所有端点一律要求登录
  // 白名单为相对挂载点的路径（中间件内 req.path 已剥离 /admin/api 前缀）
  const PUBLIC_ADMIN_PATHS = new Set(['/auth/login', '/auth/salt', '/auth/status', '/auth/logout', '/health'])
  const adminAuth = createAdminAuthMiddleware({ adminSessionStore })
  app.use('/admin/api', (req, res, next) => {
    if (PUBLIC_ADMIN_PATHS.has(req.path)) {
      return next()
    }
    return adminAuth(req, res, next)
  })

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
    const downstreamModels: Record<string, { disabled: boolean; candidates: UpstreamCandidate[] }> = {}
    for (const [alias, group] of Object.entries(config.downstreamModels)) {
      const rest = group.candidates.filter((c) => c.upstreamId !== req.params.id)
      // 候选全部被过滤掉 → 整个别名删除（保持历史行为）
      if (rest.length > 0) {
        downstreamModels[alias] = { disabled: group.disabled, candidates: rest }
      }
    }
    store.set({ ...config, upstreams, downstreamModels }, { source: 'admin' })
    res.json({ ok: true })
  })

  // 上游连通性测试：请求体可覆盖 baseUrl/apiKey（apiKey 允许为空串，Ollama 风格），否则用配置中的上游
  // 附加 Responses API 原生支持探测：supportsResponses = true（原生支持）/ false（明确不支持）/ null（探测异常或上游不可达）
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
      // Responses 原生支持探测：探测 model 取 listModels 首项 id（空数组不传 model，走 client 内部缺省）；
      // 探测异常（网络 / 超时 / 5xx / 429）不使测试失败，统一置 null
      let supportsResponses: boolean | null = null
      try {
        supportsResponses = await client.probeResponsesSupport(models[0]?.id)
      } catch (err) {
        getLogger().debug({ err }, 'Responses 支持探测异常，supportsResponses 置 null')
      }
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      res.json({ ok: true, status: 200, latencyMs, modelCount: models.length, supportsResponses })
    } catch (err) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      // 上游不可达（listModels 失败）：无法探测 Responses 支持，supportsResponses 恒为 null
      res.json({ ok: false, latencyMs, modelCount: 0, error: extractErrorCode(err), supportsResponses: null })
    }
  })

  // 上游 Responses API 能力检测：两步判定 responsesApi = 'native' | 'convert'（管理端「检测」按钮）
  // ① 非流式 POST /v1/responses（probeResponsesSupport 严格模式）：2xx + object:response → 过；
  //    400/422/404/405/401/403 及网络/超时/5xx/429 等 → fail（不再继续第二步）
  // ② 流式 POST /v1/responses（probeResponsesStream）：消费 SSE 验证事件完整（completed + message 输出事件 + output_item.added 前置）→ 过
  // 两步都过 → native；任一失败 → convert（第一步失败不再继续）；上游不可达（listModels 失败）→ { ok: false, error }
  // 探测请求由 probe 方法直接发到上游，不经路由层，天然不计入 stats/attempt；两步内部各 5s 超时
  app.post('/admin/api/upstreams/:id/detect-responses', async (req: Request, res: Response) => {
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
    try {
      // 探测 model 取 listModels 首项 id（空数组 → 不传 model，走 client 内部缺省 gpt-4o-mini）
      const models = await client.listModels()
      const model = models[0]?.id
      // 第一步：非流式探测（严格模式：400/422 也判 fail；明确不支持或探测异常 → convert，跳过流式）
      let nonStream: 'ok' | 'fail' = 'ok'
      try {
        if (!(await client.probeResponsesSupport(model, true))) {
          nonStream = 'fail'
        }
      } catch {
        // 网络错误 / 超时 / 5xx / 429 等探测异常同样按不支持处理
        nonStream = 'fail'
      }
      if (nonStream === 'fail') {
        res.json({ ok: true, responsesApi: 'convert', evidence: { nonStream: 'fail', stream: 'skipped' } })
        return
      }
      // 第二步：流式事件完整性探测（probeResponsesStream 约定不抛错，失败即 false）
      const streamOk = await client.probeResponsesStream(model)
      res.json({
        ok: true,
        responsesApi: streamOk ? 'native' : 'convert',
        evidence: { nonStream: 'ok', stream: streamOk ? 'ok' : 'fail' },
      })
    } catch (err) {
      // 上游不可达（listModels 失败等）→ 检测失败，返回错误代号
      res.json({ ok: false, error: extractErrorCode(err) })
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

  // 下游模型映射：原样返回归一化后的 group 形态（{ disabled, candidates[] }）
  app.get('/admin/api/downstream-models', (_req: Request, res: Response) => {
    res.json(store.get().downstreamModels)
  })

  // 整体替换下游模型映射：接受 alias → {disabled?, candidates: [...]} 形态（向下兼容旧 alias → [...]），
  // 先用 DownstreamModelEntrySchema 校验每条 entry，再归一化为 group 形态入库
  app.put('/admin/api/downstream-models', (req: Request, res: Response) => {
    const parsedEntries = z.record(z.string(), DownstreamModelEntrySchema).safeParse(req.body)
    if (!parsedEntries.success) {
      res.status(400).json({
        error: 'invalid_downstream_models',
        issues: parsedEntries.error.issues.map((i) => i.message),
      })
      return
    }
    // 归一化每条 entry → group 形态：DownstreamAliasGroupSchema 对内部结构再做一次兜底校验
    const normalized: Record<string, unknown> = {}
    for (const [alias, entry] of Object.entries(parsedEntries.data)) {
      const result = DownstreamAliasGroupSchema.safeParse(normalizeDownstreamAliasEntry(entry))
      if (!result.success) {
        res.status(400).json({
          error: 'invalid_downstream_models',
          alias,
          issues: result.error.issues.map((i) => i.message),
        })
        return
      }
      normalized[alias] = result.data
    }
    const config = store.get()
    store.set({ ...config, downstreamModels: normalized as Config['downstreamModels'] }, { source: 'admin' })
    res.json(normalized)
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

  // 会话客户端类型列表：供前端筛选下拉动态获取（不硬编码 client 枚举）
  app.get('/admin/api/session-clients', (_req: Request, res: Response) => {
    try {
      res.json({ clients: sessionStore.listClients() })
    } catch (err) {
      getLogger().warn({ err }, '会话客户端列表查询失败')
      res.status(500).json({ error: 'session_clients_failed' })
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

  // API Key 列表：keyword 模糊匹配 name/key_prefix；includeDisabled=true 同时返回停用记录；
  // offset/limit 游标分页，total 为满足筛选条件的总数（不含分页）；列表中的 keyHash 不回传
  app.get('/admin/api/keys', (req: Request, res: Response) => {
    const parsed = ApiKeyQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { keyword, includeDisabled, offset, limit } = parsed.data
    try {
      const { rows, total } = apiKeyStore.list({ offset, limit, keyword, includeDisabled })
      // 列表统一过滤敏感字段（keyHash）后再返回，前端只展示 keyPrefix 便于辨识
      res.json({
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          keyPrefix: r.key_prefix,
          expiresAt: r.expires_at,
          disabled: r.disabled,
          createdAt: r.created_at,
        })),
        total,
      })
    } catch (err) {
      getLogger().warn({ err }, 'API Key 列表查询失败')
      res.status(500).json({ error: 'api_key_list_failed' })
    }
  })

  // 创建 API Key：name 必填，expiresAt 0 表示永不过期；返回完整明文 apiKey（仅创建时可见一次，列表/详情不再回传）
  app.post('/admin/api/keys', (req: Request, res: Response) => {
    const parsed = ApiKeyCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { name, expiresAt } = parsed.data
    const now = Date.now()
    if (expiresAt !== 0 && expiresAt <= now) {
      res.status(400).json({ error: 'invalid_expires_at' })
      return
    }
    const apiKey = generateApiKey()
    const keyPrefix = extractKeyPrefix(apiKey)
    const keyHash = hashApiKey(apiKey)
    try {
      const row = apiKeyStore.insert({
        name,
        keyHash,
        keyPrefix,
        expiresAt,
      })
      res.status(201).json({
        id: row.id,
        name: row.name,
        apiKey, // 明文仅此处返回一次
        keyPrefix,
        expiresAt: row.expires_at,
        disabled: row.disabled,
        createdAt: row.created_at,
      })
    } catch (err) {
      getLogger().warn({ err }, 'API Key 创建失败')
      res.status(500).json({ error: 'api_key_create_failed' })
    }
  })

  // 更新 API Key：name / expiresAt / disabled 任意子集；记录不存在返回 404
  app.put('/admin/api/keys/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    const parsed = ApiKeyUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { expiresAt } = parsed.data
    if (expiresAt !== undefined) {
      const now = Date.now()
      if (expiresAt !== 0 && expiresAt <= now) {
        res.status(400).json({ error: 'invalid_expires_at' })
        return
      }
    }
    const updateInfo: { name?: string; expiresAt?: number; disabled?: boolean } = {}
    if (parsed.data.name !== undefined) updateInfo.name = parsed.data.name
    if (parsed.data.expiresAt !== undefined) updateInfo.expiresAt = parsed.data.expiresAt
    if (parsed.data.disabled !== undefined) updateInfo.disabled = parsed.data.disabled
    try {
      const ok = apiKeyStore.update(id, updateInfo)
      if (!ok) {
        res.status(404).json({ error: 'api_key_not_found' })
        return
      }
      const row = apiKeyStore.getById(id)
      if (row === undefined) {
        // 理论上不可达：update 已返回 true，但兜底返回 404
        res.status(404).json({ error: 'api_key_not_found' })
        return
      }
      res.json({
        id: row.id,
        name: row.name,
        keyPrefix: row.key_prefix,
        expiresAt: row.expires_at,
        disabled: row.disabled,
        createdAt: row.created_at,
      })
    } catch (err) {
      getLogger().warn({ err, id }, 'API Key 更新失败')
      res.status(500).json({ error: 'api_key_update_failed' })
    }
  })

  // 删除 API Key：幂等，不存在也返回 200 { deleted: false }
  app.delete('/admin/api/keys/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    try {
      res.json({ deleted: apiKeyStore.delete(id) })
    } catch (err) {
      getLogger().warn({ err, id }, 'API Key 删除失败')
      res.status(500).json({ error: 'api_key_delete_failed' })
    }
  })

  // 鉴权状态：返回当前开关 + Key 数（供前端开关切换前的提示）；
  // 扩展管理员登录态（authenticated / username）：本路由在会话中间件白名单内（未登录也可查），
  // 故按 Cookie 手工查会话判定，而非读 req.adminUser
  app.get('/admin/api/auth/status', (req: Request, res: Response) => {
    const enabled = store.get().auth?.enabled === true
    let total = 0
    try {
      total = apiKeyStore.list({ offset: 0, limit: 1, includeDisabled: true }).total
    } catch (err) {
      getLogger().warn({ err }, '鉴权状态查询失败')
    }
    let authenticated = false
    let username: string | null = null
    const sessionId = parseCookieValue(req, ADMIN_SESSION_COOKIE)
    if (sessionId !== undefined) {
      try {
        const row = adminSessionStore.getBySessionId(sessionId)
        if (row !== undefined && row.expires_at > Date.now()) {
          authenticated = true
          username = row.username
        }
      } catch (err) {
        getLogger().warn({ err }, '管理员会话查询失败')
      }
    }
    res.json({ enabled, total, authenticated, username })
  })

  // ===== 管理端登录与账号管理 =====
  // 账号局部更新（lastLoginAt / password / disabled）：store.set 原子写盘 + deepEqual 防自环
  const patchAdminAccount = (username: string, patch: Partial<AdminAccount>): boolean => {
    const config = store.get()
    const admins = config.admins
    if (admins === undefined || admins.accounts.every((a) => a.username !== username)) {
      return false
    }
    const accounts = admins.accounts.map((a) => (a.username === username ? { ...a, ...patch } : a))
    store.set({ ...config, admins: { ...admins, accounts } }, { source: 'admin' })
    return true
  }

  // 账号对外形状：绝不含明文 password，仅 hasPassword 标记
  const adminItemShape = (a: AdminAccount) => ({
    username: a.username,
    disabled: a.disabled,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
    hasPassword: a.password.length > 0,
  })

  // 登录盐 + 服务器当前 epoch 秒（前端计算 MD5(salt + ts + password)；ts 同时充当防重放窗口）
  app.get('/admin/api/auth/salt', (_req: Request, res: Response) => {
    res.json({ salt: store.get().admins?.salt ?? '', ts: Math.floor(Date.now() / 1000) })
  })

  // 登录：body { username, passwordMd5, ts }；成功建会话 + 种 HttpOnly Cookie 并刷新 lastLoginAt；
  // 「用户不存在 / 停用 / 密码错」对外同形 401（防枚举），ts 超窗单独报 timestamp_expired
  app.post('/admin/api/auth/login', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username : ''
    const passwordMd5 = typeof body.passwordMd5 === 'string' ? body.passwordMd5 : ''
    // ts 可选：客户端回传 /auth/salt 的 ts 可防重放并避免秒边界竞态；缺省时取服务器当前秒
    const clientTs = typeof body.ts === 'number' && Number.isInteger(body.ts) ? body.ts : null
    const ts = clientTs ?? Math.floor(Date.now() / 1000)
    if (username === '' || passwordMd5 === '') {
      res.status(400).json({ status: false, msg: '参数错误', error: 'invalid_login' })
      return
    }
    const admins = store.get().admins
    if (admins === undefined) {
      res.status(401).json({ status: false, msg: '用户名或密码错误', error: 'invalid_credentials' })
      return
    }
    if (clientTs !== null && !isTsWithinWindow(clientTs)) {
      res.status(401).json({ status: false, msg: '时间戳已失效', error: 'timestamp_expired' })
      return
    }
    const account = admins.accounts.find((a) => a.username === username)
    if (account === undefined || account.disabled === true) {
      res.status(401).json({ status: false, msg: '用户名或密码错误', error: 'invalid_credentials' })
      return
    }
    // 服务端用配置明文密码重算同式摘要，恒时比较（防时序攻击）
    if (!safeEqualHex(computePasswordHash(admins.salt, ts, account.password), passwordMd5)) {
      res.status(401).json({ status: false, msg: '用户名或密码错误', error: 'invalid_credentials' })
      return
    }
    try {
      const sessionId = generateSessionId()
      adminSessionStore.create({ sessionId, username, ttlMs: ADMIN_SESSION_TTL_MS })
      setSessionCookie(res, sessionId)
    } catch (err) {
      getLogger().warn({ err, username }, '创建管理员会话失败')
      res.status(500).json({ status: false, msg: '登录失败', error: 'session_create_failed' })
      return
    }
    // lastLoginAt 写回失败不影响登录结果
    try {
      patchAdminAccount(username, { lastLoginAt: new Date().toISOString() })
    } catch (err) {
      getLogger().warn({ err, username }, '更新 lastLoginAt 失败')
    }
    res.json({ status: true, msg: 'ok', username })
  })

  // 登出：幂等（无会话也清 Cookie 返回 ok）
  app.post('/admin/api/auth/logout', (req: Request, res: Response) => {
    const sessionId = parseCookieValue(req, ADMIN_SESSION_COOKIE)
    if (sessionId !== undefined) {
      try {
        adminSessionStore.delete(sessionId)
      } catch (err) {
        getLogger().warn({ err }, '登出删除会话失败')
      }
    }
    clearSessionCookie(res)
    res.json({ status: true, msg: 'ok' })
  })

  // 修改密码（需登录）：旧密码摘要校验（与登录同一算法），通过后替换为新密码
  app.post('/admin/api/auth/change-password', (req: Request, res: Response) => {
    const username = req.adminUser?.username
    if (username === undefined) {
      res.status(401).json({ status: false, msg: '未登录', error: 'unauthenticated' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const oldPasswordMd5 = typeof body.oldPasswordMd5 === 'string' ? body.oldPasswordMd5 : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    // ts 缺省取服务器当前秒（客户端一般用 /auth/salt 返回的 ts，两者相差秒级）
    const ts = typeof body.ts === 'number' && Number.isInteger(body.ts) ? body.ts : Math.floor(Date.now() / 1000)
    if (oldPasswordMd5 === '' || newPassword === '') {
      res.status(400).json({ status: false, msg: '参数错误', error: 'invalid_change_password' })
      return
    }
    const admins = store.get().admins
    const account = admins?.accounts.find((a) => a.username === username)
    if (admins === undefined || account === undefined) {
      res.status(401).json({ status: false, msg: '未登录', error: 'unauthenticated' })
      return
    }
    if (!safeEqualHex(computePasswordHash(admins.salt, ts, account.password), oldPasswordMd5)) {
      res.status(400).json({ status: false, msg: '旧密码错误', error: 'wrong_old_password' })
      return
    }
    try {
      patchAdminAccount(username, { password: newPassword })
    } catch (err) {
      getLogger().warn({ err, username }, '修改密码失败')
      res.status(500).json({ status: false, msg: '修改密码失败', error: 'change_password_failed' })
      return
    }
    res.json({ status: true, msg: '密码已修改' })
  })

  // 管理员账号列表（不含密码，需登录）
  app.get('/admin/api/admins', (_req: Request, res: Response) => {
    res.json((store.get().admins?.accounts ?? []).map(adminItemShape))
  })

  // 新增管理员账号（需登录）：重名 / 空密码 400；旧配置无 admins 节（无 salt）时顺带生成新 salt
  app.post('/admin/api/admins', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const disabled = typeof body.disabled === 'boolean' ? body.disabled : false
    if (username === '' || password === '') {
      res.status(400).json({ status: false, msg: 'username / password 不能为空', error: 'invalid_admin' })
      return
    }
    const config = store.get()
    const admins = config.admins
    const accounts = admins?.accounts ?? []
    if (accounts.some((a) => a.username === username)) {
      res.status(400).json({ status: false, msg: '用户名已存在', error: 'duplicate_username' })
      return
    }
    const now = new Date().toISOString()
    const newAccount: AdminAccount = { username, password, disabled, createdAt: now, lastLoginAt: null }
    const salt = admins?.salt ?? randomBytes(32).toString('hex')
    try {
      store.set({ ...config, admins: { salt, accounts: [...accounts, newAccount] } }, { source: 'admin' })
    } catch (err) {
      getLogger().warn({ err, username }, '创建管理员账号失败')
      res.status(500).json({ status: false, msg: '创建管理员账号失败', error: 'admin_create_failed' })
      return
    }
    res.status(201).json(adminItemShape(newAccount))
  })

  // 更新管理员账号（需登录）：password / disabled 任意子集；password 空串 = 保持原值
  app.patch('/admin/api/admins/:username', (req: Request, res: Response) => {
    const username = req.params.username
    const body = (req.body ?? {}) as Record<string, unknown>
    const hasPassword = 'password' in body
    const hasDisabled = 'disabled' in body
    if (!hasPassword && !hasDisabled) {
      res.status(400).json({ status: false, msg: '至少提供 password / disabled 之一', error: 'invalid_admin' })
      return
    }
    const config = store.get()
    const admins = config.admins
    const current = admins?.accounts.find((a) => a.username === username)
    if (current === undefined) {
      res.status(404).json({ status: false, msg: '管理员不存在', error: 'admin_not_found' })
      return
    }
    const updated: AdminAccount = { ...current }
    if (hasPassword) {
      const password = typeof body.password === 'string' ? body.password : ''
      if (password !== '') {
        updated.password = password
      }
    }
    if (hasDisabled && typeof body.disabled === 'boolean') {
      updated.disabled = body.disabled
    }
    const accounts = (admins?.accounts ?? []).map((a) => (a.username === username ? updated : a))
    const salt = admins?.salt ?? randomBytes(32).toString('hex')
    try {
      store.set({ ...config, admins: { salt, accounts } }, { source: 'admin' })
    } catch (err) {
      getLogger().warn({ err, username }, '更新管理员账号失败')
      res.status(500).json({ status: false, msg: '更新管理员账号失败', error: 'admin_update_failed' })
      return
    }
    res.json(adminItemShape(updated))
  })

  // 删除管理员账号（需登录）：禁止删自己（cannot_delete_self）；禁止删最后一个启用中的账号（last_admin）
  app.delete('/admin/api/admins/:username', (req: Request, res: Response) => {
    const username = req.params.username
    const config = store.get()
    const admins = config.admins
    const target = admins?.accounts.find((a) => a.username === username)
    if (target === undefined) {
      res.status(404).json({ status: false, msg: '管理员不存在', error: 'admin_not_found' })
      return
    }
    if (req.adminUser?.username === username) {
      res.status(400).json({ status: false, msg: '不能删除当前登录的管理员', error: 'cannot_delete_self' })
      return
    }
    const enabledCount = (admins?.accounts ?? []).filter((a) => a.disabled === false).length
    if (target.disabled === false && enabledCount <= 1) {
      res.status(400).json({ status: false, msg: '不能删除最后一个启用中的管理员', error: 'last_admin' })
      return
    }
    const accounts = (admins?.accounts ?? []).filter((a) => a.username !== username)
    const salt = admins?.salt ?? ''
    try {
      store.set({ ...config, admins: { salt, accounts } }, { source: 'admin' })
    } catch (err) {
      getLogger().warn({ err, username }, '删除管理员账号失败')
      res.status(500).json({ status: false, msg: '删除管理员账号失败', error: 'admin_delete_failed' })
      return
    }
    res.json({ status: true, msg: 'ok' })
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

  // 保存系统配置：部分更新 server / routing / auth 三节（请求体缺省的键不修改现有值）
  // 校验用 ConfigSchema.pick（三节本身 optional，未知顶层键被过滤）；写回复用 store.set（原子写盘 + deepEqual 防自环）
  // restartRequired 语义：本次请求体实际提供的、需重启才生效的顶层键——
  //   server 节（监听 host/port 与 bodyLimit 在进程启动时绑定）→ 含 'server'；
  //   routing 节（会话亲和开关与清理参数在启动时读取，节内无其它字段）→ 含 'routing'；
  //   auth 节每请求实时读 store，永不列入
  app.put('/admin/api/config', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const parsed = ConfigSchema.pick({ server: true, routing: true, auth: true }).safeParse(req.body)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      res
        .status(400)
        .json({ status: false, msg: `系统配置校验失败：${issues.join('；')}`, error: 'invalid_config', issues })
      return
    }
    // 注：AuthConfigSchema 的 .prefault({}) 会使未提供的 auth 节也带默认值出现在 parsed.data，
    // 直接合并会把未提供的节静默重置为默认值（例如把已启用的鉴权关掉），故按请求体实际提供的键过滤
    const patch: Partial<Pick<Config, 'server' | 'routing' | 'auth'>> = {}
    if (body.server !== undefined) patch.server = parsed.data.server
    if (body.routing !== undefined) patch.routing = parsed.data.routing
    if (body.auth !== undefined) patch.auth = parsed.data.auth
    // 需重启的顶层键：以请求体实际提供的键为准（与写入过滤同一判据）
    const restartRequired: string[] = []
    if (body.server !== undefined) restartRequired.push('server')
    if (body.routing !== undefined) restartRequired.push('routing')
    try {
      const config = store.get()
      store.set({ ...config, ...patch }, { source: 'admin' })
    } catch (err) {
      getLogger().warn({ err }, '保存系统配置失败')
      res.status(500).json({ status: false, msg: '保存系统配置失败', error: 'config_save_failed' })
      return
    }
    res.json({ status: true, msg: '系统配置已保存', config: patch, restartRequired })
  })

  // 最近一次外部重载错误（无则 null）
  app.get('/admin/api/config/reload-error', (_req: Request, res: Response) => {
    const err = store.getRecentReloadError()
    res.json({ error: err === null || err === undefined ? null : err instanceof Error ? err.message : String(err) })
  })
}

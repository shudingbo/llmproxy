// 管理端 REST 接口：/admin/api/* 全部端点
// 职责：上游增删改查与连通性测试、下游模型映射替换、日志查询、统计、健康检查、配置查看与重载错误
// 无鉴权（由部署层防护）、无 CORS（开发期走 web/vite 代理）；apiKey 一律不落日志、响应中全部掩码
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import type { Express, Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { DownstreamModelSchema, UpstreamSchema, type UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { getApiLogFilePath, getAppLogFilePath } from '../paths.js'
import type { StatsCounter } from '../stats/counter.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { DOWNSTREAM_ENDPOINTS } from './downstreams.js'
import { resolveListen } from './listen.js'
import { maskApiKey } from './admin-helpers.js'

// 依赖注入集合：由装配层（T19）构造后传入
export interface AdminDeps {
  store: ConfigStore
  getUpstreamClient: (id: string) => OpenAIUpstreamClient | undefined
  stats: StatsCounter
}

// 日志查询参数（date 必填且必须是 YYYY-MM-DD；type 区分 app/api；level/keyword 可选）
// type 默认 app，向后兼容旧调用；api 类型时返回 JSON 行的完整字段，app 类型时把文本行也按 JSON 形状还原
// offset/limit 游标分页：从文件尾部反向读取，最新在前；offset 是"已跳过的匹配行数"，limit 默认 100 上限 500
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

// log4js / pino 共同的级别数值映射（前端 Logs 视图契约）：trace=10 debug=20 info=30 warn=40 error=50 fatal=60
const LEVEL_NUMBERS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

// level 名 → 数值（用于文本格式的 app 日志：'[2026-...][INFO]...）
const LEVEL_NAME_TO_VALUE: Record<string, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
}

// 解析 log4js pattern 输出的文本行 [time] [LEVEL] [category] msg
// 末尾的 msg 可含空格与中括号（cat 用时例外），这里简单按前三段切分后剩余整体作为 msg
function parseAppLine(line: string): { level: number; time: string; category: string; msg: string } | null {
  // 匹配前三个 [..] 段：[time] [LEVEL] [category]，剩余一并作为 msg
  const m = /^(\[[^\]\n]+\]) (\[[^\]\n]+\]) (\[[^\]\n]+\]) (.*)$/.exec(line)
  if (m === null) return null
  const time = m[1].slice(1, -1)
  const levelStr = m[2].slice(1, -1)
  const category = m[3].slice(1, -1)
  const msg = m[4] ?? ''
  return { level: LEVEL_NAME_TO_VALUE[levelStr] ?? 0, time, category, msg }
}

// 每次反向读取的块大小：64KB，只读文件尾部所需部分，不读整个文件
const READ_CHUNK_SIZE = 64 * 1024

// 反向读取日志页：从文件尾部向前分块扫描，最新在前；offset 跳过前 offset 条匹配行
interface TailLogPage {
  lines: unknown[]
  hasMore: boolean
  scanned: number
}

function readLogsTail(
  filePath: string,
  type: 'app' | 'api',
  levelValue: number,
  keyword: string | undefined,
  offset: number,
  limit: number,
): TailLogPage {
  const fd = openSync(filePath, 'r')
  try {
    const { size } = fstatSync(fd)
    const lines: unknown[] = []
    let scanned = 0
    let hasMore = false
    if (size === 0) {
      return { lines, hasMore, scanned }
    }
    // 过滤单行（app 文本 / api JSON）：空行、解析失败、级别不足、不含关键词 → null
    const matchLine = (rawLine: string): Record<string, unknown> | null => {
      if (rawLine.trim() === '') return null
      if (type === 'api') {
        // api 日志每行都应是合法 JSON；解析失败直接跳过
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(rawLine) as Record<string, unknown>
        } catch {
          return null
        }
        if (typeof obj.level === 'number' && obj.level < levelValue) return null
        if (keyword !== undefined && keyword !== '' && typeof obj.msg === 'string' && !obj.msg.includes(keyword)) {
          return null
        }
        return obj
      }
      // app 日志是文本：[time] [LEVEL] [category] msg，解析后合成与 api 相同的字段形状
      const parsed = parseAppLine(rawLine)
      if (parsed === null) return null
      if (parsed.level < levelValue) return null
      if (keyword !== undefined && keyword !== '' && !parsed.msg.includes(keyword)) return null
      return { level: parsed.level, time: parsed.time, category: parsed.category, msg: parsed.msg }
    }
    // 处理一行：空行不计 scanned；匹配行先跳过 offset 条再收集；返回是否已凑够 limit
    let skipped = 0
    const emitLine = (rawLine: string): boolean => {
      const line = rawLine.replace(/\r$/, '')
      if (line.trim() === '') return false
      scanned++
      const obj = matchLine(line)
      if (obj === null) return false
      if (skipped < offset) {
        skipped++
        return false
      }
      lines.push(obj)
      return lines.length >= limit
    }

    let pos = size
    let buf = Buffer.alloc(0)
    let filled = false
    while (pos > 0 && !filled) {
      const start = Math.max(0, pos - READ_CHUNK_SIZE)
      const chunk = Buffer.allocUnsafe(pos - start)
      readSync(fd, chunk, 0, chunk.length, start)
      pos = start
      // 新 chunk 拼到已收集字节的最前（更早内容在前）；跨块保持原始字节，UTF-8 字符不被截断
      buf = Buffer.concat([chunk, buf])
      // 从尾部逐个取完整行（0x0A 分隔）；末尾可能是半行，保留等下一 chunk 补全后再解码
      let end = buf.length
      while (end > 0 && !filled) {
        const nl = buf.lastIndexOf(0x0a, end - 1)
        if (nl === -1) break
        filled = emitLine(buf.toString('utf-8', nl + 1, end))
        end = nl
      }
      buf = buf.subarray(0, end)
    }

    // 已读到文件开头：剩余字节全部处理（可能含 filled 时未处理完的多个完整行 + 文件首行）
    if (buf.length > 0) {
      for (const part of buf.toString('utf-8').split('\n')) {
        if (filled) {
          // 已凑够本页：仅探测剩余是否还有匹配行（决定 hasMore），不再收集
          if (matchLine(part) !== null) {
            hasMore = true
            break
          }
        } else if (emitLine(part)) {
          filled = true
        }
      }
    }

    // 提前凑够 limit 且文件还有未读字节 → 更早处仍有日志 → hasMore=true
    if (filled && pos > 0) {
      hasMore = true
    }
    return { lines, hasMore, scanned }
  } finally {
    closeSync(fd)
  }
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

/**
 * 注册管理端路由（挂到传入的 Express 应用上）。
 * 假定装配层已注入 express.json（10mb）与请求日志中间件。
 */
export function registerAdminRoutes(app: Express, deps: AdminDeps): void {
  const { store, getUpstreamClient, stats } = deps

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

  // 日志查询：date 必填；type 区分 app（文本）或 api（JSON）；按级别阈值 + 关键词过滤；
  // 反向读取文件尾部（最新在前），offset/limit 游标分页；hasMore 表示更早处是否还有匹配日志
  app.get('/admin/api/logs', (req: Request, res: Response) => {
    const parsed = LogQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { date, type, level, keyword, offset, limit } = parsed.data
    const levelValue = LEVEL_NUMBERS[level ?? 'info'] ?? 30
    // 选取对应类别的日志文件：app-YYYY-MM-DD.log 或 api-YYYY-MM-DD.log
    const sampleDate = new Date(`${date}T12:00:00`)
    const filePath =
      type === 'api' ? getApiLogFilePath(sampleDate) : getAppLogFilePath(sampleDate)
    if (!existsSync(filePath)) {
      res.json({ lines: [], type, offset, limit, hasMore: false, scanned: 0 })
      return
    }
    try {
      const page = readLogsTail(filePath, type, levelValue, keyword, offset, limit)
      res.json({ ...page, type, offset, limit })
    } catch (err) {
      getLogger().warn({ err, filePath }, `日志反向读取失败: ${filePath}`)
      res.status(500).json({ error: 'log_read_failed' })
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

  // 健康检查：进程存活 + 版本 + 各上游健康状态（disabled → paused）
  // 附 downstreams：与启动日志同一份端点清单，供 web Dashboard 渲染下游 API 表
  // baseUrl / host / port / listenSource：当前进程实际生效的下行流入口（与 startServer 共用 resolveListen）
  app.get('/admin/api/health', (_req: Request, res: Response) => {
    const upstreams: Record<string, 'healthy' | 'paused'> = {}
    for (const u of store.get().upstreams) {
      upstreams[u.id] = u.disabled ? 'paused' : 'healthy'
    }
    const listen = resolveListen(store.get())
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: getVersion(),
      upstreams,
      downstreams: DOWNSTREAM_ENDPOINTS,
      host: listen.host,
      port: listen.port,
      baseUrl: `http://${listen.host}:${listen.port}`,
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

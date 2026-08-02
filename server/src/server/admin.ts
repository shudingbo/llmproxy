// 管理端 REST 接口：/admin/api/* 全部端点
// 职责：上游增删改查与连通性测试、下游模型映射替换、日志查询、统计、健康检查、配置查看与重载错误
// 无鉴权（由部署层防护）、无 CORS（开发期走 web/vite 代理）；apiKey 一律不落日志、响应中全部掩码
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Express, Request, Response } from 'express'
import pino from 'pino'
import { z, type ZodType } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { DownstreamModelSchema, UpstreamSchema, type UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { getLogDir } from '../paths.js'
import type { StatsCounter } from '../stats/counter.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { maskApiKey } from './admin-helpers.js'

// 依赖注入集合：由装配层（T19）构造后传入
export interface AdminDeps {
  store: ConfigStore
  getUpstreamClient: (id: string) => OpenAIUpstreamClient | undefined
  stats: StatsCounter
}

// 日志查询参数（date 必填且必须是 YYYY-MM-DD；level/keyword 可选）
interface LogQuery {
  date: string
  level?: string
  keyword?: string
}

const LogQuerySchema: ZodType<LogQuery> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  level: z.string().optional().default('info'),
  keyword: z.string().optional(),
})

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

// 60 秒统计快照装饰器：unref 保证不阻塞进程退出；模块级防重（多次注册只启动一个）
let statsTimerStarted = false
function startStatsSnapshotTimer(stats: StatsCounter): void {
  if (statsTimerStarted) {
    return
  }
  statsTimerStarted = true
  const log = getLogger()
  setInterval(() => {
    log.info({ stats: stats.snapshot() }, 'stats-snapshot')
  }, 60_000).unref()
}

/**
 * 注册管理端路由（挂到传入的 Express 应用上）。
 * 假定装配层已注入 express.json（10mb）与请求日志中间件。
 */
export function registerAdminRoutes(app: Express, deps: AdminDeps): void {
  const { store, getUpstreamClient, stats } = deps
  startStatsSnapshotTimer(stats)

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

  // 日志查询：读取指定日期文件，按 pino 级别阈值（≥ selected）与关键词过滤，返回最后 1000 条
  app.get('/admin/api/logs', (req: Request, res: Response) => {
    const parsed = LogQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues.map((i) => i.message) })
      return
    }
    const { date, level, keyword } = parsed.data
    // pino 级别数值：trace=10 debug=20 info=30 warn=40 error=50 fatal=60
    const levelValue = (pino.levels.values as Record<string, number>)[level ?? 'info'] ?? 30
    const filePath = join(getLogDir(), `app-${date}.log`)
    const lines: unknown[] = []
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        if (line.trim() === '') {
          continue
        }
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          // 级别低于阈值 → 跳过；关键词命中 msg 字段（大小写敏感）
          if (typeof obj.level === 'number' && obj.level < levelValue) {
            continue
          }
          if (keyword !== undefined && keyword !== '' && typeof obj.msg === 'string' && !obj.msg.includes(keyword)) {
            continue
          }
          lines.push(obj)
        } catch {
          // 非 JSON 行（如启动横幅）直接跳过
        }
      }
    }
    res.json({ lines: lines.slice(-1000) })
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
  app.get('/admin/api/health', (_req: Request, res: Response) => {
    const upstreams: Record<string, 'healthy' | 'paused'> = {}
    for (const u of store.get().upstreams) {
      upstreams[u.id] = u.disabled ? 'paused' : 'healthy'
    }
    res.json({ status: 'ok', uptime: process.uptime(), version: getVersion(), upstreams })
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

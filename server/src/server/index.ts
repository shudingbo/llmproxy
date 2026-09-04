// 单端口生产装配层：Express 应用组合与进程引导
// 只监听一个端口（PORT，默认 3000）；管理端 /admin/api、OpenAI /v1、Ollama /api、
// 静态 SPA（web/dist）与 index 回退全部挂在同一应用上，无第二个端口
import express, { type Express, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from '../config/store.js'
import { Router } from '../router/index.js'
import { RoundRobinLoadBalancer, SessionAffinityLoadBalancer } from '../router/load-balancer.js'
import { SessionStore } from '../session/db.js'
import { LogStore } from '../logstore/index.js'
import { SessionMonitor } from '../monitor/index.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { StatsCounter } from '../stats/counter.js'
import { ApiKeyStore } from '../auth/db.js'
import { createAuthMiddleware } from '../auth/middleware.js'
import { AdminSessionStore } from '../auth/session-store.js'
import { getConfigPath, getDataDir, getLogDir } from '../paths.js'
import { getLogger, initLogRetention, requestLogger, configureLogging, setLogStore } from '../logger/index.js'
import { RETENTION_DAYS } from '../logger/sweep.js'
import { registerAdminRoutes } from './admin.js'
import { registerOpenAIRoutes } from './openai.js'
import { registerOllamaRoutes } from './ollama.js'
import { DOWNSTREAM_ENDPOINTS, type DownstreamEndpoint } from './downstreams.js'
import { resolveListen, type CliArgs } from './listen.js'

// 启动时按下游类型分组打印一份端点清单：与 admin/api/health.downstreams 同源
function logDownstreamEndpoints(endpoints: ReadonlyArray<DownstreamEndpoint>): void {
  const grouped = new Map<DownstreamEndpoint['type'], DownstreamEndpoint[]>()
  for (const ep of endpoints) {
    const list = grouped.get(ep.type) ?? []
    list.push(ep)
    grouped.set(ep.type, list)
  }
  // 三类下游按固定顺序输出，避免随机抖动
  for (const type of ['openai', 'ollama', 'admin'] as const) {
    const list = grouped.get(type)
    if (list === undefined || list.length === 0) {
      continue
    }
    for (const ep of list) {
      getLogger().info(`path: ${ep.path} ${ep.summary}`, 'downstream-ready')
    }
  }
}

// 装配层依赖：配置存储 + 前端构建产物目录（web/dist 的绝对路径）
export interface AppDeps {
  store: ConfigStore
  webDistPath: string
  // 命令行 --host/--port：透传到管理端路由（如 /admin/api/health），保证返回值与 app.listen 一致
  cli?: CliArgs
}

/**
 * 组合 Express 应用（可测试）：中间件、三组 API 路由、静态 SPA 与 index 回退。
 * 上游客户端映射按配置构建并在配置变更时重建，新增/删除上游即时生效。
 */
export function createApp(deps: AppDeps): Express {
  const { store, webDistPath, cli } = deps

  // 上游客户端映射：配置变更时重建，保证新增/删除上游无需重启
  const clients = new Map<string, OpenAIUpstreamClient>()
  // 按上游 ID 取客户端：请求处理器共用
  const getUpstreamClient = (id: string): OpenAIUpstreamClient | undefined => clients.get(id)
  const rebuildClients = (): void => {
    clients.clear()
    for (const upstream of store.get().upstreams) {
      clients.set(upstream.id, openaiClient(upstream))
    }
  }
  rebuildClients()
  store.subscribe(rebuildClients)

  // 单例负载均衡器与统计计数器（跨请求共享）
  // 会话亲和均衡器：同一会话（内容前缀 hash / Open WebUI chat_id）粘附同一上游，利用 LLM prompt cache；
  // 无会话键的请求委托内部轮询均衡器，行为不变
  const sessionStore = new SessionStore(join(getDataDir(), 'llmproxy.db'))
  // 日志 SQLite 存储：与 SessionStore 共用 ~/llmproxy/llmproxy.db（WAL 多连接安全）
  const logStore = new LogStore(join(getDataDir(), 'llmproxy.db'))
  // API Key 鉴权存储：与 SessionStore / LogStore 共用 ~/llmproxy/llmproxy.db
  const apiKeyStore = new ApiKeyStore(join(getDataDir(), 'llmproxy.db'))
  // 管理端会话存储：与 ApiKeyStore 共用 ~/llmproxy/llmproxy.db（WAL 多连接安全）
  const adminSessionStore = new AdminSessionStore(join(getDataDir(), 'llmproxy.db'))
  // 会话消息监控存储：与 SessionStore / LogStore 共用 ~/llmproxy/llmproxy.db（WAL 多连接安全）；
  // 持久化各会话与 LLM 交互的消息，实时推送给管理端"探测"抽屉（SSE）
  const monitor = new SessionMonitor(join(getDataDir(), 'llmproxy.db'))
  // 双写：所有 getLogger().info/warn/... 在写文件的同时写 SQLite
  setLogStore(logStore)
  // 会话亲和总开关：routing.sessionAffinity.enabled 缺省为 true（schema 已给默认值），
  // 仅当显式配置为 false 时退回纯轮询均衡器；开关在启动时确定，不做热更新重选
  const affinityEnabled = store.get().routing?.sessionAffinity?.enabled !== false
  const loadBalancer = affinityEnabled
    ? new SessionAffinityLoadBalancer(sessionStore, new RoundRobinLoadBalancer())
    : new RoundRobinLoadBalancer()
  const stats = new StatsCounter()

  // 会话粘附自动清理：读配置取保留期与清理周期，启动执行一次 + 周期调度（interval 0 关闭）
  const routing = store.get().routing?.sessionAffinity
  const cleanupInterval = routing?.cleanupIntervalMs ?? 3600000
  const cleanupMaxAge = routing?.cleanupMaxAgeMs ?? 604800000
  const runCleanup = (): void => {
    try {
      const deleted = sessionStore.cleanup(cleanupMaxAge)
      if (deleted > 0) getLogger().info(`会话清理完成，删除 ${deleted} 条`, 'session-cleanup')
      // 级联：会话映射已删除的会话键，其监控消息一并清理（孤儿清扫）
      const orphaned = monitor.deleteOrphaned()
      if (orphaned > 0) getLogger().info(`会话消息孤儿清理完成，删除 ${orphaned} 条`, 'session-message-cleanup')
    } catch (err) {
      getLogger().warn('会话清理失败', err)
    }
  }
  runCleanup() // 启动执行一次
  if (cleanupInterval > 0) {
    setInterval(runCleanup, cleanupInterval).unref()
  }

  // 日志 DB 清理：保留期与文件 sweep 一致（RETENTION_DAYS 天），启动执行一次 + 周期调度（与 sweep.ts 的 SWEEP_INTERVAL_MS 一致）
  const LOG_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
  const cleanupLogs = (): void => {
    try {
      const deleted = logStore.cleanup(RETENTION_DAYS * 24 * 60 * 60 * 1000)
      if (deleted > 0) getLogger().info(`日志 DB 清理完成，删除 ${deleted} 条`, 'log-cleanup')
      // 会话消息保留期兜底清扫：与日志同保留期（RETENTION_DAYS 天），孤儿清扫之外的时间维度保险
      const expired = monitor.deleteExpired(RETENTION_DAYS * 24 * 60 * 60 * 1000)
      if (expired > 0) getLogger().info(`会话消息过期清理完成，删除 ${expired} 条`, 'session-message-cleanup')
    } catch (err) {
      getLogger().warn('日志 DB 清理失败', err)
    }
  }
  cleanupLogs() // 启动执行一次
  setInterval(cleanupLogs, LOG_SWEEP_INTERVAL_MS).unref()

  // API Key 过期清理：每天一次清理「已过期超过 cleanupRetentionDays 天」的 Key；
  // 保留期由 auth.cleanupRetentionDays 控制（缺省 7 天，0 = 过期即清理），
  // 启动时读一次配置；配置变更后下次清理周期生效，不重启进程
  const cleanupApiKeys = (): void => {
    try {
      const retentionDays = store.get().auth?.cleanupRetentionDays ?? 7
      const deleted = apiKeyStore.cleanupExpired(retentionDays)
      if (deleted > 0) {
        getLogger().info(
          `过期 API Key 清理完成（保留 ${retentionDays} 天），删除 ${deleted} 条`,
          'apikey-cleanup',
        )
      }
    } catch (err) {
      getLogger().warn('API Key 清理失败', err)
    }
  }
  cleanupApiKeys() // 启动执行一次
  setInterval(cleanupApiKeys, 24 * 60 * 60 * 1000).unref()

  // 管理端会话过期清理（24h 滑动过期）：启动执行一次 + 每 6 小时
  const cleanupAdminSessions = (): void => {
    try {
      const deleted = adminSessionStore.cleanup()
      if (deleted > 0) {
        getLogger().info(`管理员会话清理完成，删除 ${deleted} 条`, 'admin-session-cleanup')
      }
    } catch (err) {
      getLogger().warn('管理员会话清理失败', err)
    }
  }
  cleanupAdminSessions() // 启动执行一次
  setInterval(cleanupAdminSessions, 6 * 60 * 60 * 1000).unref()

  // 每次上游尝试的统计钩子：直接计入计数器（status 字段被忽略，AttemptInfo 不需它）
  const onAttempt = (info: { upstreamId: string; ok: boolean; durationMs: number; status?: number }): void => {
    stats.recordAttempt(info)
  }

  // 兼容注入的路由器实例：openai.ts / ollama.ts 内部实际按 store.get() 逐请求重建，
  // 此实例仅用于满足 deps 形状，不会产生过期引用
  const router = new Router(store.get())

  const app = express()
  // 请求体解析：先于路由；上限取 server.bodyLimit（缺省 '10mb'，大体积多模态请求）。
  // 与监听 host/port 同属进程级配置：createApp 装配时读取一次配置，热重载不重新应用，改后需重启
  app.use(express.json({ limit: store.get().server?.bodyLimit ?? '10mb' }))
  // 请求日志中间件：每个请求生成 requestId 并记录方法/URL/状态码/耗时；
  // 白名单（logger 模块内硬编码 LOG_EXCLUDE_PATHS，含 '/admin/api/logs'）内的请求跳过日志写入，
  // 避免日志查询接口自身污染日志
  app.use(requestLogger)
  // API Key 鉴权中间件：仅作用于 /v1/* 与 /api/*；管理端 /admin/api 无鉴权（由部署层防护）。
  // 鉴权开关关闭时中间件旁路，开关读取每次请求走 store.get() 支持热更新
  const authMiddleware = createAuthMiddleware({ store, apiKeyStore })
  // 管理端会话鉴权：在 registerAdminRoutes 内全局挂载到 /admin/api，除白名单
  // （/auth/login、/auth/salt、/auth/status、/auth/logout、/health）外所有端点一律要求登录
  // 三组 API 路由：管理端 / OpenAI 兼容 / Ollama 兼容
  registerAdminRoutes(app, { store, getUpstreamClient, stats, sessionStore, logStore, apiKeyStore, adminSessionStore, monitor, cli })
  registerOpenAIRoutes(app, {
    store,
    getUpstreamClient,
    router,
    loadBalancer,
    onAttempt,
    sessionStore,
    monitor,
    authMiddleware,
  })
  registerOllamaRoutes(app, {
    store,
    getUpstreamClient,
    router,
    loadBalancer,
    onAttempt,
    sessionStore,
    monitor,
    authMiddleware,
  })

  // 静态 SPA 产物（由 web 包 vite build 生成）；目录缺失时 express.static 只回 404，不抛错
  app.use(express.static(webDistPath))

  // SPA 回退：非 API 前缀（/v1 /api /admin）的请求一律交给前端入口。
  // 产物缺失（全新检出未先构建 web 包）时返回 503 JSON，而不是抛 ENOENT
  const indexHtml = join(webDistPath, 'index.html')
  app.get(/^(?!\/v1|\/api|\/admin).*/, (_req: Request, res: Response) => {
    if (!existsSync(indexHtml)) {
      res.status(503).json({
        error: 'admin_ui_not_built',
        message: 'run pnpm --filter @llmproxy/web build',
      })
      return
    }
    res.sendFile(indexHtml)
  })

  return app
}

/**
 * 解析命令行参数：--host <v> / --host=<v>、--port <v> / --port=<v>
 * - port 非法值（非 1-65535 整数）与 host 空值一律忽略，回落到 config > default 优先级
 * - 返回值属性缺失即未提供；startServer 无 cli 参数时行为与旧版一致
 */
function parseCliArgs(argv: string[]): { host?: string; port?: number } {
  const out: { host?: string; port?: number } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // --host <v>：值在下一元素，取到后 i++ 跳过避免重复消费
    if (a === '--host') {
      const v = argv[i + 1]?.trim()
      if (v !== undefined && v !== '') {
        out.host = v
        i++
      }
      continue
    }
    // --host=<v>：值在同一元素内，无需跳过下一元素
    if (a.startsWith('--host=')) {
      const v = a.slice('--host='.length).trim()
      if (v !== '') out.host = v
      continue
    }
    if (a === '--port') {
      const n = Number(argv[i + 1])
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        out.port = n
        i++
      }
      continue
    }
    if (a.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length))
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out.port = n
    }
  }
  return out
}

/**
 * 进程引导入口（二进制入口）：定位前端产物目录、装载配置、组合应用并监听 PORT。
 * 历史重载错误不阻塞启动，仅记录告警。
 */
export function startServer(): void {
  // 启动期先把 log4js 配置好（幂等），所有后续 logger 调用都走入两套分类
  configureLogging()
  const logger = getLogger()

  // 前端产物目录：从当前模块位置逐级向上推导（dev 用 tsx 直接跑 src 时同样成立），
  // 缺省回退到 CWD/web/dist
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../../../web/dist'),
    resolve(process.cwd(), 'web/dist'),
  ]
  const webDistPath = candidates.find((p) => existsSync(join(p, 'index.html'))) ?? candidates[candidates.length - 1]

  const store = new ConfigStore(getConfigPath())
  // 启动不阻塞：历史配置重载错误仅告警，不中断引导
  const reloadError = store.getRecentReloadError()
  if (reloadError !== null && reloadError !== undefined) {
    logger.warn({ err: reloadError }, '存在历史配置重载错误，继续启动')
  }

  const cli = parseCliArgs(process.argv)
  const app = createApp({ store, webDistPath, cli })
  // 日志保留期清理：进程内启动每日清扫定时器
  initLogRetention(getLogDir())

  const listen = resolveListen(store.get(), { cli })
  const port = listen.port
  const host = listen.host
  app.listen(port, host, () => {
    logger.info(
      `ready on http://${host}:${port} (source=${listen.source})`,
    )
    // 启动期间打印当前暴露的全部下行流端点，方便部署/排障一眼可查
    logDownstreamEndpoints(DOWNSTREAM_ENDPOINTS)
  })
}

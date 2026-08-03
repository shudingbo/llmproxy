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
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { StatsCounter } from '../stats/counter.js'
import { getConfigPath, getDataDir, getLogDir } from '../paths.js'
import { getLogger, initLogRetention, requestLogger, configureLogging, setLogStore } from '../logger/index.js'
import { RETENTION_DAYS } from '../logger/sweep.js'
import { registerAdminRoutes } from './admin.js'
import { registerOpenAIRoutes } from './openai.js'
import { registerOllamaRoutes } from './ollama.js'
import { DOWNSTREAM_ENDPOINTS, type DownstreamEndpoint } from './downstreams.js'
import { resolveListen } from './listen.js'

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
}

/**
 * 组合 Express 应用（可测试）：中间件、三组 API 路由、静态 SPA 与 index 回退。
 * 上游客户端映射按配置构建并在配置变更时重建，新增/删除上游即时生效。
 */
export function createApp(deps: AppDeps): Express {
  const { store, webDistPath } = deps

  // 上游客户端映射：配置变更时重建，保证新增/删除上游无需重启
  const clients = new Map<string, OpenAIUpstreamClient>()
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
    } catch (err) {
      getLogger().warn('日志 DB 清理失败', err)
    }
  }
  cleanupLogs() // 启动执行一次
  setInterval(cleanupLogs, LOG_SWEEP_INTERVAL_MS).unref()

  // 每次上游尝试的统计钩子：直接计入计数器（status 字段被忽略，AttemptInfo 不需它）
  const onAttempt = (info: { upstreamId: string; ok: boolean; durationMs: number; status?: number }): void => {
    stats.recordAttempt(info)
  }

  // 兼容注入的路由器实例：openai.ts / ollama.ts 内部实际按 store.get() 逐请求重建，
  // 此实例仅用于满足 deps 形状，不会产生过期引用
  const router = new Router(store.get())
  const getUpstreamClient = (id: string): OpenAIUpstreamClient | undefined => clients.get(id)

  const app = express()
  // 请求体解析：先于路由，10mb 上限（大体积多模态请求）
  app.use(express.json({ limit: '10mb' }))
  // 请求日志中间件：每个请求生成 requestId 并记录方法/URL/状态码/耗时
  app.use(requestLogger)
  // 三组 API 路由：管理端 / OpenAI 兼容 / Ollama 兼容
  registerAdminRoutes(app, { store, getUpstreamClient, stats, sessionStore, logStore })
  registerOpenAIRoutes(app, { store, getUpstreamClient, router, loadBalancer, onAttempt, sessionStore })
  registerOllamaRoutes(app, { store, getUpstreamClient, router, loadBalancer, onAttempt, sessionStore })

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

  const app = createApp({ store, webDistPath })
  // 日志保留期清理：进程内启动每日清扫定时器
  initLogRetention(getLogDir())

  const listen = resolveListen(store.get())
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

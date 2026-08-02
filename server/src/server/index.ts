// 单端口生产装配层：Express 应用组合与进程引导
// 只监听一个端口（PORT，默认 3000）；管理端 /admin/api、OpenAI /v1、Ollama /api、
// 静态 SPA（web/dist）与 index 回退全部挂在同一应用上，无第二个端口
import express, { type Express, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from '../config/store.js'
import { Router } from '../router/index.js'
import { RoundRobinLoadBalancer } from '../router/load-balancer.js'
import { openaiClient, OpenAIUpstreamClient } from '../upstream/openai.js'
import { StatsCounter } from '../stats/counter.js'
import { getConfigPath, getLogDir } from '../paths.js'
import { getLogger, initLogRetention, requestLogger } from '../logger/index.js'
import { registerAdminRoutes } from './admin.js'
import { registerOpenAIRoutes } from './openai.js'
import { registerOllamaRoutes } from './ollama.js'

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
  const loadBalancer = new RoundRobinLoadBalancer()
  const stats = new StatsCounter()

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
  registerAdminRoutes(app, { store, getUpstreamClient, stats })
  registerOpenAIRoutes(app, { store, getUpstreamClient, router, loadBalancer, onAttempt })
  registerOllamaRoutes(app, { store, getUpstreamClient, router, loadBalancer, onAttempt })

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

  const port = Number(process.env.PORT) || 3000
  const host = process.env.HOST ?? '127.0.0.1'
  app.listen(port, () => {
    logger.info({ port, host }, `ready on http://${host}:${port}`)
  })
}

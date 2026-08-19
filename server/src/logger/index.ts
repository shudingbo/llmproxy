// log4js 双类别日志：app（调试信息）走文本 pattern layout，api（HTTP 请求）走 JSON layout
// 配置外置于 ~/llmproxy/log4js.json，启动期确保该文件存在（缺省时自动写入一份并由用户后续编辑）
// 两类均按日轮转（streamroller dateFile）+ stdout 镜像，便于 docker/tmux 直接看
// 日志格式样例：
//   app: [2026-03-31T16:48:45.839] [INFO] [app] downstream-ready { type: 'openai', ... }
//   api: {"level":30,"time":1774...",msg":"request-complete","requestId":"...","method":"GET",...}
import log4js, { type Configuration, type Logger } from 'log4js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { nanoid } from 'nanoid'
import { getDataDir, getLog4jsConfigPath, getLogDir } from '../paths.js'
import type { LogEntry, LogStore } from '../logstore/index.js'
import { initLogRetention, stopLogRetention, sweepOldLogs } from './sweep.js'

// 敏感请求头：任何情况下都不允许出现在日志里（匹配时忽略大小写）
// cookie：管理端会话 sessionId 载体，泄露即等于会话劫持，一律不落文件/SQLite
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie'])

// pino 兼容的级别数值映射（保持前端 Logs 视图契约不变）
const LEVEL_NUMBERS: Record<string, number> = {
  ALL: 0,
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
  OFF: 70,
}

// 模块级状态：configureLogging 一次性调用，后续幂等
let configured = false

// 默认的 log4js 配置对象构造器（以 logDir 为参数，因为路径跟 home 目录相关，无法写死在 JSON 中）
// 此函数同时被 boot 期间写默认文件 用，也是测试断言默认结构的依据
// 备注：date-format@4 在 log4js 里只识别小写 hh / mm / ss 与大写 yyyy / MM / dd / SSS，
// HH 是字面字符，毫秒分隔的 T 也是字面。ISO 时间戳需用 yyyy-MM-ddThh:mm:ss.SSS（不再转义 T）
export function buildDefaultLog4jsConfig(logDir: string): Configuration {
  return {
    appenders: {
      appStdout: {
        type: 'stdout',
        layout: { type: 'pattern', pattern: '[%d{yyyy-MM-ddThh:mm:ss.SSS}] [%p] [%c] %m' },
      },
      appFile: {
        type: 'dateFile',
        filename: join(logDir, 'app'),
        pattern: 'yyyy-MM-dd.log',
        alwaysIncludePattern: true,
        keepFileExt: false,
        // 流式 streamroller 默认分隔符是 .，会产出 app.2026-08-03.log；用 - 取得 -YYYY-MM-DD 连接形式
        fileNameSep: '-',
        layout: { type: 'pattern', pattern: '[%d{yyyy-MM-ddThh:mm:ss.SSS}] [%p] [%c] %m' },
      },
      apiFile: {
        type: 'dateFile',
        filename: join(logDir, 'api'),
        pattern: 'yyyy-MM-dd.log',
        alwaysIncludePattern: true,
        keepFileExt: false,
        fileNameSep: '-',
        layout: { type: 'pinoJson' },
      },
    },
    categories: {
      default: { appenders: ['appStdout', 'appFile'], level: 'info' },
      app: { appenders: ['appStdout', 'appFile'], level: 'info' },
      api: { appenders: ['apiFile'], level: 'info' },
    },
  }
}

/**
 * 自定义 JSON layout：与原 pino 输出契约一致（level/time/msg + 任意字段）。
 * 把 log4js 的 variadic data 数组合并：首个对象为结构化字段（与 pino 的
 * `logger.info({obj}, 'msg')` 语义一致）；其他字符串/Error 一并合并到 msg。
 */
function installPinoJsonLayout(): void {
  log4js.addLayout('pinoJson', () => (logEvent) => {
    const obj: Record<string, unknown> = {
      level: LEVEL_NUMBERS[logEvent.level.levelStr] ?? 30,
      time: logEvent.startTime.getTime(),
    }
    const msgParts: string[] = []
    for (const piece of logEvent.data) {
      if (piece instanceof Error) {
        obj.err = { name: piece.name, message: piece.message, stack: piece.stack }
        msgParts.push(`err=${piece.message}`)
      } else if (typeof piece === 'object' && piece !== null && !Array.isArray(piece)) {
        Object.assign(obj, piece)
      } else if (typeof piece === 'string') {
        msgParts.push(piece)
      } else if (piece !== undefined && piece !== null) {
        msgParts.push(String(piece))
      }
    }
    const msg = msgParts.join(' ').trim()
    if (msg !== '') {
      obj.msg = msg
    }
    return JSON.stringify(obj) + '\n'
  })
}

/**
 * 一次性配置 log4js：从 ~/llmproxy/log4js.json 加载；文件不存在则写一份默认值。
 * 自定义 layout（pinoJson）必须先于 configure 注册，因 appender.laytout.type='pinoJson' 依赖它
 * 启动期首调一次；后续重复调用为 no-op
 */
export function configureLogging(): void {
  if (configured) {
    return
  }
  configured = true

  installPinoJsonLayout()

  const configPath = getLog4jsConfigPath()
  const dataDir = getDataDir()
  const logDir = getLogDir()
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(logDir, { recursive: true, mode: 0o700 })

  // 缺省配置首次启动写入一份，供运维在此基础上按需编辑；后续启动不再覆盖
  if (!existsSync(configPath)) {
    const defaultConfig = buildDefaultLog4jsConfig(logDir)
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), { mode: 0o600 })
  }

  // 从文件加载：log4js.configure 接受文件路径，同步读取与解析；解析失败抛错
  // 故意不在 catch 里"写默认覆盖"：用户的自定义配置出错应被运维看见，而不是被静默覆盖
  log4js.configure(configPath)
}

// 按 category 缓存的 Logger 实例：log4js.getLogger() 每次都返回新对象，
// 缓存可让测试 vi.spyOn(getLogger('app'), 'info') 真正命中生产代码后续调用
const loggerCache = new Map<string, Logger>()

// ---- SQLite 双写（可选装配，不依赖 log4js 自定义 appender）----
// 装配层通过 setLogStore 注入 LogStore；未注入时 getLogger 行为与原来完全一致（现有调用零感知）
let logStore: LogStore | undefined

// 一次性故障标记：api 日志高频，DB 故障时避免每行都刷屏
let sqliteWriteFailed = false

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

// 包装缓存与原始 logger 缓存分离，setLogStore 时整体失效重建
const wrappedLoggerCache = new Map<string, Logger>()

/**
 * 注入（或解除）LogStore：设置后 getLogger/getApiLogger 返回双写包装；传 undefined 恢复纯文件行为。
 */
export function setLogStore(store: LogStore | undefined): void {
  logStore = store
  wrappedLoggerCache.clear()
  if (store !== undefined) {
    sqliteWriteFailed = false
  }
}

// 深度脱敏：剔除对象树中任意层级的 authorization / x-api-key（大小写不敏感），其余原样保留
function sanitizeRawValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRawValue(item))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
        continue
      }
      out[key] = sanitizeRawValue(item)
    }
    return out
  }
  return value
}

/**
 * 解析日志参数为 LogEntry（合并规则与 installPinoJsonLayout 一致）。
 */
function extractLogEntry(name: string, method: string, args: unknown[]): LogEntry {
  const type = name === 'api' ? 'api' : 'app'
  const entry: LogEntry = {
    type,
    level: LEVEL_NUMBERS[method.toUpperCase()] ?? 30,
    time: Date.now(),
    // app 类别：category 列默认记 logger 名（与文本格式 [app] 对应），对象内 category 字段可覆盖
    ...(type === 'app' ? { category: name } : {}),
  }
  const msgParts: string[] = []
  const raw: Record<string, unknown> = {}
  for (const piece of args) {
    if (piece instanceof Error) {
      raw.err = { name: piece.name, message: piece.message, stack: piece.stack }
      msgParts.push(`err=${piece.message}`)
    } else if (typeof piece === 'object' && piece !== null && !Array.isArray(piece)) {
      const obj = piece as Record<string, unknown>
      if (typeof obj.requestId === 'string') entry.requestId = obj.requestId
      if (typeof obj.method === 'string') entry.method = obj.method
      if (typeof obj.url === 'string') entry.url = obj.url
      if (typeof obj.status === 'number') entry.status = obj.status
      if (typeof obj.durationMs === 'number') entry.durationMs = obj.durationMs
      if (typeof obj.category === 'string') entry.category = obj.category
      // 整对象并入 raw（无损，含 headers 等）；敏感键由 sanitizeRawValue 兜底剔除
      Object.assign(raw, obj)
    } else if (typeof piece === 'string') {
      msgParts.push(piece)
    } else if (piece !== undefined && piece !== null) {
      msgParts.push(String(piece))
    }
  }
  const msg = msgParts.join(' ').trim()
  if (msg !== '') {
    entry.msg = msg
  }
  if (Object.keys(raw).length > 0) {
    entry.raw = JSON.stringify(sanitizeRawValue(raw))
  }
  return entry
}

// 双写包装：拦截日志方法先写 SQLite（try-catch 隔离）再写文件；其余属性/方法原样透传
function wrapLoggerWithStore(l: Logger, name: string): Logger {
  return new Proxy(l, {
    get(target: Logger, prop: PropertyKey, receiver: unknown): unknown {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && LOG_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]): unknown => {
          try {
            logStore?.insert(extractLogEntry(name, prop, args))
          } catch (err) {
            // 错误隔离：DB 失败绝不影响文件日志；提示走原始 logger 的 warn（非包装），避免死循环
            if (!sqliteWriteFailed) {
              sqliteWriteFailed = true
              try {
                target.warn.call(target, '日志写入 SQLite 失败', err)
              } catch {
                // 提示失败也吞掉：日志调用对业务永不抛错
              }
            }
          }
          return value.apply(target, args)
        }
      }
      return value
    },
  })
}

/**
 * 通用 logger：未指定 name 时落到 'app' category（与 default 等价）。
 * 同一 name 多次调用返回同一 Logger 实例（按 category 缓存）。
 * 已装配 LogStore 时返回双写包装（按 name 缓存）；未装配时原样返回，现有调用零感知。
 */
export function getLogger(name?: string): Logger {
  const key = name ?? 'app'
  let l = loggerCache.get(key)
  if (l === undefined) {
    l = log4js.getLogger(key)
    loggerCache.set(key, l)
  }
  if (logStore === undefined) {
    return l
  }
  let wrapped = wrappedLoggerCache.get(key)
  if (wrapped === undefined) {
    wrapped = wrapLoggerWithStore(l, key)
    wrappedLoggerCache.set(key, wrapped)
  }
  return wrapped
}

/**
 * HTTP 请求日志 logger：仅 requestLogger 中间件使用，写入 api 类别的 JSON 文件。
 */
export function getApiLogger(): Logger {
  return getLogger('api')
}

/**
 * 同步冲刷所有 appender（测试用兼容入口：log4js 无 sync flush 接口，调用 shutdown 即可）。
 * 实际生产不用调用——log4js.shutdown 在进程退出钩子里处理异步落盘。
 */
export function flushLoggerSync(): void {
  // log4js 的 dateFile appender 内部用 streamroller，shutdown 是异步的；
  // 测试场景下 fs 读取端用轮询等待即可，无需在此阻塞。
}

// 带 requestId 的请求 / 响应对象类型（局部扩展，避免污染全局 Express 类型声明）
interface RequestWithLog extends Request {
  requestId?: string
}
interface ResponseWithLog extends Response {
  requestId?: string
}

/**
 * 过滤敏感请求头（Authorization / x-api-key，大小写不敏感），其余原样放行。
 */
function redactHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const safe: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      safe[key] = value
    }
  }
  return safe
}

/**
 * API 请求日志白名单：精确路径前缀，命中任一前缀的请求不写入 api 日志
 * （既不写文件也不入 SQLite）。典型用途：高 QPS 的管理端查询自身（/admin/api/logs），
 * 防止日志查询反过来污染日志。
 *
 * 当前白名单：
 * - /admin/api/logs：日志查询接口（GET /admin/api/logs、DELETE /admin/api/logs/cleanup 等）
 *
 * 如需扩展白名单，直接修改本常量即可；前缀匹配（保留尾部 /），子路径自动命中
 */
const LOG_EXCLUDE_PATHS: readonly string[] = ['/admin/api/logs']

/**
 * 路径是否命中白名单：精确前缀匹配，命中任一前缀即返回 true
 * - 例 prefixes=['/admin/api/logs']，path='/admin/api/logs' 或 '/admin/api/logs/cleanup' → true
 *
 * 仅以 req.originalUrl（路由完整 URL，未做路由替换）与 req.url 兜底为基础做字符串比对，
 * 不解析查询串；查询串在 Express 5 中已自动剥离
 */
function isPathExcluded(url: string): boolean {
  for (const prefix of LOG_EXCLUDE_PATHS) {
    if (url === prefix || url.startsWith(`${prefix}`)) {
      return true
    }
  }
  return false
}

/**
 * Express 请求日志中间件：使用 api category（JSON 格式）。
 * 与原 pino 版本行为一致：每个请求生成 requestId，响应完成输出结构化日志。
 * 绝不记录请求体，也绝不记录 Authorization / x-api-key。
 *
 * 白名单内的请求（精确前缀命中 LOG_EXCLUDE_PATHS）既不写 api 文件日志，也不入 SQLite 日志库；
 * 用于避免日志查询接口自身污染日志
 */
export function requestLogger(req: RequestWithLog, res: ResponseWithLog, next: NextFunction): void {
  const requestId = nanoid()
  req.requestId = requestId
  res.requestId = requestId
  const startedAt = process.hrtime.bigint()
  const reqLogger = getApiLogger()
  const url = req.originalUrl ?? req.url ?? ''
  // 白名单内的请求跳过 finish 日志（连 res.on('finish') 都不挂，零开销）
  if (isPathExcluded(url)) {
    next()
    return
  }
  res.on('finish', () => {
    const durationMs = Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100
    reqLogger.info(
      {
        requestId,
        method: req.method,
        url: req.originalUrl ?? req.url,
        status: res.statusCode,
        durationMs,
        headers: redactHeaders(req.headers),
      },
      'request-complete',
    )
  })
  next()
}

// 重导出保留期清理入口，便于引导代码统一从 logger 模块引入
export { initLogRetention, stopLogRetention, sweepOldLogs }

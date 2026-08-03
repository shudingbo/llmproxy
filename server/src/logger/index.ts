// pino 日志器单例：按本地日期分文件（app-YYYY-MM-DD.log），同时镜像输出到 stdout
// 所有日志调用都经由自定义 write 包装流：先做日期翻转检查与文件目标写入，再 tee 一份到控制台
// 控制台输出已经过 pino redact 脱敏，密钥/请求头敏感字段不会出现
import pino, { type Logger } from 'pino'
import { mkdirSync, openSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { dirname } from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { nanoid } from 'nanoid'
import { getLogFilePath, getLocalDateString } from '../paths.js'
import { initLogRetention, stopLogRetention, sweepOldLogs } from './sweep.js'

// 敏感请求头：任何情况下都不允许出现在日志里（匹配时忽略大小写）
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key'])

// 目标流的最小结构（pino.destination 返回的 SonicBoom 满足该结构）
interface LogDestination {
  write(chunk: string): void
  flushSync?(): void
  end?(): void
}

// stdout 控制台目标：直接写 process.stdout，确保 pino redact 已经对内容脱敏后再输出
function createConsoleDestination(): LogDestination {
  return {
    write(chunk: string): void {
      // 直接同步写：避免异步缓冲在进程退出时丢失最后几条日志
      // 控制台输出是单进程串行源，竞态风险由 Node 单线程事件循环天然消除
      process.stdout.write(chunk)
    },
    flushSync(): void {
      // stdout 自身不需要额外的同步冲刷
    },
  }
}

// 模块级单例状态（惰性初始化）
let loggerInstance: Logger | null = null
let currentDate = ''
let currentFileDest: LogDestination | null = null
let consoleDest: LogDestination | null = null

/**
 * 创建指向 logPath 的文件目标流。
 * 先同步建目录并打开 fd，再交给 pino.destination（async 写入）；这样目标流立即可用，
 * 避免异步打开时 fd 尚未就绪导致 flushSync 抛 "sonic boom is not ready yet"。
 */
function createFileDestination(logPath: string): LogDestination {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  return pino.destination({ fd, sync: false })
}

/**
 * 若本地日期已翻转，则关闭旧日志文件并切换目标流到新日期的文件。
 * 每次写日志前调用；首次调用时完成目标流初始化。
 */
function maybeRotate(): void {
  const now = new Date()
  const date = getLocalDateString(now)
  if (currentFileDest !== null && currentDate === date) return
  // 日期变化（或首次）：创建指向新日期文件的目标流
  const newDest = createFileDestination(getLogFilePath(now))
  if (currentFileDest !== null) {
    // 先冲刷再关闭旧目标，避免异步缓冲内容丢失
    currentFileDest.flushSync?.()
    currentFileDest.end?.()
  }
  currentFileDest = newDest
  currentDate = date
}

/**
 * 获取日志器单例（惰性初始化，无参数，路径来自 paths.ts）。
 * 包装流在每次写入前检查日期翻转；子 logger 通过原型链共享同一包装流，因此同样受控。
 */
export function getLogger(): Logger {
  if (loggerInstance !== null) return loggerInstance
  consoleDest ??= createConsoleDestination()
  const stream: pino.DestinationStream = {
    write(chunk: string): void {
      maybeRotate()
      currentFileDest?.write(chunk)
      // stdout 镜像：运维/tmux/docker logs 能直接看到日志
      consoleDest?.write(chunk)
    },
  }
  loggerInstance = pino(
    {
      level: 'info',
      // 纵深防御：即便调用方误传敏感头字段，pino 自身也会脱敏
      redact: {
        paths: ['authorization', 'x-api-key', '*.authorization', '*.x-api-key'],
        censor: '[REDACTED]',
      },
    },
    stream,
  )
  return loggerInstance
}

/**
 * 同步冲刷当前日志目标（测试用：确保缓冲日志落盘后可断言）。
 */
export function flushLoggerSync(): void {
  currentFileDest?.flushSync?.()
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
 * Express 请求日志中间件：为每个请求生成 requestId（nanoid），
 * 响应完成（finish）时输出结构化日志（方法 / URL / 状态码 / 耗时 / 脱敏后的请求头）。
 * 绝不记录请求体，也绝不记录 Authorization / x-api-key。
 */
export function requestLogger(req: RequestWithLog, res: ResponseWithLog, next: NextFunction): void {
  const requestId = nanoid()
  req.requestId = requestId
  res.requestId = requestId
  const startedAt = process.hrtime.bigint()
  const reqLogger = getLogger().child({ requestId })
  res.on('finish', () => {
    const durationMs = Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100
    reqLogger.info(
      {
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

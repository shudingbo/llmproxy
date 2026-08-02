// 顺序回退执行器：从负载均衡选出的起点开始，按 wrap 顺序逐个尝试候选
// 只做"顺序尝试 + 结果判定 + 尝试日志"，不含任何 HTTP / 流式代码
// 是否可回退（fallbackable）由调用方（请求处理器）决定，这里只消费该标记
import type { UpstreamCandidate } from '../config/schema.js'
import { EmptyCandidatesError, type LoadBalancer, type RequestCtx } from './load-balancer.js'

/**
 * 单次调用的结果：
 * - ok: true → 成功，携带 value
 * - ok: false → 失败，携带 error 与 fallbackable（true 表示本次失败可触发回退）
 */
export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; fallbackable: boolean }

/**
 * 尝试日志条目：每次调用候选记录一条
 * - status：成功且 value 带 status 字段时记录，否则 undefined
 * - errorCode：失败时记录错误代号（如 ECONNREFUSED / PARSE / 500），不记录堆栈
 */
export interface AttemptLogEntry {
  upstreamId: string
  model: string
  status?: number
  durationMs: number
  fallbackable: boolean
  errorCode?: string
}

/**
 * 回退执行的整体结果：ok 标记成败，value / error 二选一，attemptLog 记录全部尝试
 */
export interface FallbackResult<T> {
  ok: boolean
  value?: T
  error?: unknown
  attemptLog: AttemptLogEntry[]
}

/**
 * 从错误对象中提取错误代号，供日志记录：
 * - Node 网络错误带 code（ECONNREFUSED / ETIMEDOUT / ECONNRESET / ENOTFOUND）
 * - 业务错误带 status / statusCode（如 400、429、500）
 * - 其余情况返回 undefined，绝不记录堆栈
 */
function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const e = error as Record<string, unknown>
  if (typeof e.code === 'string') {
    return e.code
  }
  const status = e.status ?? e.statusCode
  if (typeof status === 'number') {
    return String(status)
  }
  return undefined
}

/**
 * 从成功结果中提取 status（若 value 恰好带该字段），否则 undefined
 */
function extractStatus<T>(value: T): number | undefined {
  if (value && typeof value === 'object') {
    const status = (value as Record<string, unknown>).status
    if (typeof status === 'number') {
      return status
    }
  }
  return undefined
}

/**
 * 顺序回退执行器：
 * 1. 候选为空 → 抛 EmptyCandidatesError
 * 2. 用负载均衡器选起点 start，构建 wrap 顺序：[start, start+1, ..., end, 0, ..., start-1]
 *    （负载均衡只调用一次：游标只随新请求推进，同请求内的回退不推进游标）
 * 3. 依序调用 callFn：
 *    - 成功：记录日志并立即返回 { ok: true, value, attemptLog }
 *    - 失败且 fallbackable：继续尝试下一个候选
 *    - 失败且 !fallbackable（如 401/403/普通 4xx）：立即中断，不再回退
 * 4. 全部失败：返回最后一个错误与完整尝试日志
 */
export async function executeWithFallback<T>(
  candidates: UpstreamCandidate[],
  lb: LoadBalancer,
  ctx: RequestCtx,
  callFn: (candidate: UpstreamCandidate) => Promise<CallResult<T>>,
): Promise<FallbackResult<T>> {
  if (candidates.length === 0) {
    throw new EmptyCandidatesError()
  }
  // 起点由负载均衡器决定；同请求内的后续回退固定按 wrap 顺序走，不再问 lb
  const start = lb.pick(candidates, ctx)
  const startIndex = candidates.indexOf(start)
  // wrap 顺序：[start, start+1, ..., end, 0, ..., start-1]
  const ordered = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)]

  const attemptLog: AttemptLogEntry[] = []
  let lastError: unknown

  for (const candidate of ordered) {
    const startedAt = process.hrtime.bigint()
    const result = await callFn(candidate)
    // bigint 差值转毫秒，避免 Date.now() 的毫秒级截断误差
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    if (result.ok) {
      // 成功即终止回退：成功响应永远不会触发 fallbackable
      attemptLog.push({
        upstreamId: candidate.upstreamId,
        model: candidate.model,
        status: extractStatus(result.value),
        durationMs,
        fallbackable: false,
      })
      return { ok: true, value: result.value, attemptLog }
    }

    lastError = result.error
    attemptLog.push({
      upstreamId: candidate.upstreamId,
      model: candidate.model,
      durationMs,
      fallbackable: result.fallbackable,
      errorCode: extractErrorCode(result.error),
    })
    // 不可回退的错误（如 401/403、普通 4xx）：继续尝试其它上游无意义，直接中断
    if (!result.fallbackable) {
      break
    }
  }

  // 走完整个 wrap 列表仍无成功：返回最后一个错误与全部尝试记录
  return { ok: false, error: lastError, attemptLog }
}

/**
 * 把 axios 错误映射为 fallbackable 标记（供请求处理器使用，本模块自身不发起 HTTP）：
 * - 网络错误（ECONNREFUSED / ETIMEDOUT / ECONNRESET / ENOTFOUND）、上游超时、解析错误 → true
 * - HTTP 5xx、429 → true
 * - 其它 4xx（含 401/403，鉴权问题在每个上游都会重复出现）→ false
 */
export function isFallbackableAxiosError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const e = error as { code?: unknown; isAxiosError?: unknown; message?: unknown; response?: { status?: unknown } }

  // 网络层错误：未建立连接 / 超时 / 连接被重置 / DNS 解析失败
  if (typeof e.code === 'string') {
    const networkCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND']
    if (networkCodes.includes(e.code)) {
      return true
    }
  }
  // 上游超时：axios 超时中断的 error 通常带 isAxiosError 且 message 含 timeout
  if (e.isAxiosError && typeof e.message === 'string' && /timeout/i.test(e.message)) {
    return true
  }
  // 已收到 HTTP 响应：按状态码判定
  const status = typeof e.response?.status === 'number' ? e.response.status : undefined
  if (status !== undefined) {
    return status === 429 || status >= 500
  }
  return false
}

// 会话 token 用量统计：捕获上游返回的 usage（输入/输出 token 数）与首 token 时延（TTFT），累加进 sessions 表
//
// 数据来源（全部直接取自上游响应，无需估算）：
//   - 非流式 chat：响应体 usage 字段（{ prompt_tokens, completion_tokens, total_tokens }，多数 OpenAI 兼容上游默认返回）
//   - 流式 chat：网关已向上游注入 stream_options.include_usage=true（见 upstream/openai.ts），
//     兼容上游会在流末尾补发一个带顶层 usage 的最终块 → SSE tap 解析
//   - Responses 原生：response.completed 事件内 response.usage（input_tokens / output_tokens / total_tokens）
//   - Responses convert：转换器已把 chat 流捕获的 usage 注入 response.completed（见 converters/responses-stream.ts）
//   - /api/chat：底层仍是 OpenAI chat completions 调用，走 chat 口径
// 上游未返回 usage（或流在 usage 块到达前被中断）→ 只记能拿到的：
//   request_count 仍 +1，token 数累加 0，收到过内容 delta 才记首 token 时延
//
// 失败隔离（与日志双写 / monitor 同契约）：DB 写失败仅告警一次，绝不抛错、绝不影响业务请求
import type { Readable } from 'node:stream'
import { getLogger } from '../logger/index.js'
import type { SessionUsageRecord } from './db.js'

// usage 快照（统一 chat 口径：prompt / completion；Responses 口径在捕获处归一化）
export interface UsageSnapshot {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// 计时口径：firstTokenMs 为首 token 时延（0 = 未测量）；generationMs 为输出生成时长
export interface TimingStats {
  firstTokenMs: number
  firstTokenMeasured: number
  generationMs: number
}

// 最小存储形状：SessionStore 结构上满足；recordUsage 可选（路由层注入的 SessionStoreLike
// 测试 fake 可缺省该能力，缺省即 no-op）
export interface UsageStoreLike {
  recordUsage?(sessionKey: string, record: SessionUsageRecord): boolean
}

// hrtime bigint 差值 → 毫秒（四舍五入到整数 ms；时间跨度远小于 2^53 ns，Number 转换安全）
const toMs = (ns: bigint): number => Math.max(0, Math.round(Number(ns) / 1e6))

// 非负整数收敛：非 number / 非有限 / 负数 → 0（上游 usage 字段防御性处理）
const toInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)

// 非流式 chat 响应体 → usage 快照；usage 缺失 / 全 0 / 结构不符 → null
// total_tokens 缺失时回退为输入 + 输出之和（部分上游只回两项）
export function extractChatUsage(data: unknown): UsageSnapshot | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const usage = (data as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return null
  }
  const u = usage as Record<string, unknown>
  const promptTokens = toInt(u.prompt_tokens)
  const completionTokens = toInt(u.completion_tokens)
  const totalTokens = toInt(u.total_tokens)
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens > 0 ? totalTokens : promptTokens + completionTokens,
  }
}

// 非流式 Responses 响应体 → usage 快照（response.usage：input_tokens / output_tokens / total_tokens）
export function extractResponsesUsage(data: unknown): UsageSnapshot | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const usage = (data as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return null
  }
  const u = usage as Record<string, unknown>
  const promptTokens = toInt(u.input_tokens)
  const completionTokens = toInt(u.output_tokens)
  const totalTokens = toInt(u.total_tokens)
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens > 0 ? totalTokens : promptTokens + completionTokens,
  }
}

// chat SSE chunk 的 delta 是否携带可见内容（正文或思考）：
// 与 AssistantStreamRecorder 的提取口径一致——content 非空串 / reasoning_content 非空串 /
// reasoning_details 存在非空 text 元素（MiniMax reasoning_split 累计快照）
function chatDeltaHasContent(delta: unknown): boolean {
  if (typeof delta !== 'object' || delta === null) {
    return false
  }
  const d = delta as Record<string, unknown>
  if (typeof d.content === 'string' && d.content !== '') {
    return true
  }
  if (typeof d.reasoning_content === 'string' && d.reasoning_content !== '') {
    return true
  }
  if (Array.isArray(d.reasoning_details)) {
    for (const item of d.reasoning_details) {
      if (typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string') {
        return true
      }
    }
  }
  return false
}

// chat / responses 两种 SSE 口径的首 token 事件判定：返回该事件是否携带可见内容增量
function responsesEventHasContent(evt: { type?: string; delta?: unknown }): boolean {
  const hasDelta = typeof evt.delta === 'string' && evt.delta !== ''
  if (evt.type === 'response.output_text.delta') {
    return hasDelta
  }
  // 思考增量先于正文到达：推理模型的首 token 通常是思考 token，同样计入 TTFT
  if (evt.type === 'response.reasoning_text.delta' || evt.type === 'response.reasoning_summary_text.delta') {
    return hasDelta
  }
  return false
}

// 流式用量 tap：被动挂接上游 SSE 流的 data 事件（与 pipe / monitor 记录器共存，不消费流）
//   - chat 口径：首个携带内容的 delta → 首 token 时延；顶层 chunk.usage → token 数（最后一次生效）
//   - responses 口径：首个 output_text / reasoning_text delta → 首 token 时延；
//     response.completed 事件内 response.usage → token 数
// finish 幂等（正常 end 与中断 close 都触发）：计算计时指标 + 回调 onDone（usage 快照或 null）
export class SseUsageTap {
  private readonly kind: 'chat' | 'responses'
  private readonly startedAt: bigint
  private readonly onDone: (usage: UsageSnapshot | null, timing: TimingStats) => void
  // 跨 chunk 累积未换行的字节（单条 SSE 行可能跨多个 chunk，与 stream-recorder 同处理）
  private buffer = ''
  // 首个内容 delta 到达的 hrtime 时刻（null = 未测量）
  private firstDeltaAt: bigint | null = null
  // 最后一次捕获的 usage 快照
  private usage: UsageSnapshot | null = null
  private finished = false

  constructor(opts: {
    kind: 'chat' | 'responses'
    // 成功候选发起上游请求的 hrtime 时刻（TTFT 零点；回退场景取最终成功那次尝试的时刻）
    startedAt: bigint
    onDone: (usage: UsageSnapshot | null, timing: TimingStats) => void
  }) {
    this.kind = opts.kind
    this.startedAt = opts.startedAt
    this.onDone = opts.onDone
  }

  // 挂接流监听：data 喂行解析；end 正常结束；close 中断结束（两者先后触发时 finish 幂等去重，
  // 中断与正常结束在统计口径上等价：能收到多少记多少）
  attach(stream: Readable): void {
    stream.on('data', (chunk: Buffer | string) => this.feed(chunk))
    stream.on('end', () => this.finish())
    stream.on('close', () => this.finish())
  }

  // 喂入一个 chunk；finish 之后为 no-op
  feed(chunk: Buffer | string): void {
    if (this.finished) {
      return
    }
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString()
    // 按 \n 切出完整行处理；残留的不完整行留在 buffer 等待下一个 chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.consumeLine(line)
    }
  }

  // 结束（幂等）：处理残留字节（EOF 前未换行的最后一条 data 行）后计算指标并回调
  finish(): void {
    if (this.finished) {
      return
    }
    this.finished = true
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer)
      this.buffer = ''
    }
    const now = process.hrtime.bigint()
    const firstTokenMs = this.firstDeltaAt !== null ? toMs(this.firstDeltaAt - this.startedAt) : 0
    // 生成时长：有首 token 时取 流结束 − 首 token（输出 token 的流出窗口）；否则取全程
    const generationMs = this.firstDeltaAt !== null ? toMs(now - this.firstDeltaAt) : toMs(now - this.startedAt)
    this.onDone(this.usage, {
      firstTokenMs,
      firstTokenMeasured: firstTokenMs > 0 ? 1 : 0,
      generationMs,
    })
  }

  // 处理一条完整行（含 \r 兼容）：只认 data: 行，其余（event: / 注释 / 空行）忽略
  private consumeLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) {
      return
    }
    const payload = line.slice(5).trimStart()
    if (payload === '' || payload === '[DONE]') {
      return
    }
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(payload) as Record<string, unknown>
    } catch {
      // 非 JSON 的 data 行静默跳过（不断流、不抛错）
      return
    }
    if (this.kind === 'chat') {
      this.consumeChat(evt)
    } else {
      this.consumeResponses(evt)
    }
  }

  private consumeChat(evt: Record<string, unknown>): void {
    // 首 token 时延：首个携带内容的 delta 时刻（role-only 的首块不计）
    if (this.firstDeltaAt === null) {
      const choices = evt.choices
      const delta = Array.isArray(choices) && choices.length > 0 ? (choices[0] as { delta?: unknown })?.delta : undefined
      if (chatDeltaHasContent(delta)) {
        this.firstDeltaAt = process.hrtime.bigint()
      }
    }
    // usage：顶层 chunk.usage（include_usage 的最终块；后到覆盖先到）
    const usage = evt.usage
    if (typeof usage === 'object' && usage !== null) {
      const u = usage as Record<string, unknown>
      const snap = extractChatUsage({ usage: u })
      if (snap !== null) {
        this.usage = snap
      }
    }
  }

  private consumeResponses(evt: Record<string, unknown>): void {
    const event = evt as { type?: string; delta?: unknown; response?: unknown }
    // 首 token 时延：首个正文 / 思考 delta 时刻
    if (this.firstDeltaAt === null && responsesEventHasContent(event)) {
      this.firstDeltaAt = process.hrtime.bigint()
    }
    // usage：response.completed 事件内的 response.usage（convert 路径的转换流同样注入该事件）
    if (event.type === 'response.completed' && typeof event.response === 'object' && event.response !== null) {
      const snap = extractResponsesUsage(event.response)
      if (snap !== null) {
        this.usage = snap
      }
    }
  }
}

// DB 写失败仅告警一次（后续同类失败静默，与 monitor / 日志双写同契约）
let usageWriteFailed = false

// 失败隔离记录：把一次成功请求的 usage + 计时指标累加进会话行。
// store / sessionKey 缺失 → no-op（无会话请求、或装配未注入会话存储）；
// DB 写失败仅告警一次、绝不抛错（业务请求不受影响）
export function recordSessionUsage(
  store: UsageStoreLike | undefined,
  sessionKey: string | undefined,
  usage: UsageSnapshot | null,
  timing: TimingStats,
): void {
  if (store === undefined || store.recordUsage === undefined || sessionKey === undefined) {
    return
  }
  const record: SessionUsageRecord = {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    firstTokenMs: timing.firstTokenMs,
    firstTokenMeasured: timing.firstTokenMeasured,
    generationMs: timing.generationMs,
  }
  try {
    store.recordUsage(sessionKey, record)
  } catch (err) {
    if (!usageWriteFailed) {
      usageWriteFailed = true
      getLogger().warn({ err }, '会话用量统计记录失败（后续同类错误不再告警）')
    }
  }
}

// 测试专用：重置"写失败仅告警一次"标志（vitest 模块缓存跨用例保持，需显式重置）
export function __resetUsageWriteFailedForTest(): void {
  usageWriteFailed = false
}

// Chat Completions SSE → Responses SSE 事件流转换器
// 输入：上游 OpenAI chat 格式 SSE 字节流（data: {choices:[{delta:{content}}]} / data: [DONE] / usage 块）
// 输出：OpenAI Responses 格式 SSE 事件流，事件序列对齐 Responses API 流式契约：
//   response.created → response.in_progress → response.output_item.added → response.content_part.added
//   → response.output_text.delta（多个）→ response.output_text.done → response.content_part.done
//   → response.output_item.done → response.completed
// 注意：不使用尾部缓冲——usage 在实时块流中捕获（最后一次 usage 生效，注入 response.completed）
import { Transform } from 'node:stream'
import type { Readable, TransformCallback } from 'node:stream'
import { nanoid } from 'nanoid'
import { getLogger } from '../logger/index.js'
import type {
  ResponsesOutputMessage,
  ResponsesOutputTextPart,
  ResponsesResponse,
  ResponsesUsage,
} from './responses-types.js'

// 从 OpenAI 块中提取增量内容（choices[0].delta.content）。
// 结构缺失 / 类型不符时返回空串，调用方据此跳过（绝不输出空 delta 事件）
function extractDeltaContent(chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null) return ''
  const choices = (chunk as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const choice = choices[0]
  if (typeof choice !== 'object' || choice === null) return ''
  const delta = (choice as Record<string, unknown>).delta
  if (typeof delta !== 'object' || delta === null) return ''
  const content = (delta as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

// 从 OpenAI 块中提取 usage 快照（顶层 chunk.usage）：chat 字段名 → Responses 字段名。
// 数值字段缺省为 0；无 usage 时返回 null
function extractUsage(chunk: unknown): ResponsesUsage | null {
  if (typeof chunk !== 'object' || chunk === null) return null
  const usage = (chunk as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null) return null
  const record = usage as Record<string, unknown>
  const snapshot: ResponsesUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  if (typeof record.prompt_tokens === 'number') {
    snapshot.input_tokens = record.prompt_tokens
  }
  if (typeof record.completion_tokens === 'number') {
    snapshot.output_tokens = record.completion_tokens
  }
  if (typeof record.total_tokens === 'number') {
    snapshot.total_tokens = record.total_tokens
  }
  return snapshot
}

/**
 * 流式转换器：逐行解析上游 chat SSE，输出 Responses SSE 事件序列。
 * - 单条 data: 事件可能跨多个上游 chunk，用 buffer 累积原始字节
 * - 首字节输出前先发 opening 事件序列（created/in_progress/output_item.added/content_part.added）
 * - 内容块解析失败 → warn + 跳过（不中断流）
 * - 结束（[DONE] 或上游 EOF）→ 输出收尾事件序列（output_text.done → ... → response.completed），
 *   空输出（无任何 delta）也保持完整事件序列
 */
class ChatToResponsesStream extends Transform {
  // 跨 chunk 累积的原始字节（未遇到 \n 的行留在这里等待拼接）
  private buffer = ''
  // 已拼接的完整文本（delta 累加，收尾事件使用）
  private text = ''
  // 最后一次看到的 usage（后到覆盖先到，注入 response.completed）
  private usage: ResponsesUsage | null = null
  // opening 事件序列是否已输出（首个 delta 或收尾前触发一次）
  private opened = false
  // 是否已输出收尾事件序列（防止 [DONE] 与 EOF 各触发一次）
  private finalized = false
  // 本响应的稳定标识：所有事件共用同一 resp/msg id
  private readonly respId = `resp_${nanoid()}`
  private readonly msgId = `msg_${nanoid()}`
  private readonly createdAt = Math.floor(Date.now() / 1000)

  constructor(private readonly model: string) {
    // 双端字节模式：写入侧收上游 SSE 字节流，读取侧吐 Responses SSE 字节流
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  /** 上游传输错误（TCP 重置 / 响应阶段异常等）：输出 error 事件后结束，不做重试 */
  onUpstreamError(err: unknown): void {
    if (this.finalized) {
      return
    }
    this.finalized = true
    const message = err instanceof Error ? err.message : String(err)
    this.pushEvent('error', { type: 'error', error: { type: 'upstream_error', message } })
    this.push(null)
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer += chunk.toString('utf8')
    // 按 \n 切出完整行；未出现 \n 的行留在 buffer 等待下一个 chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.processLine(line)
      nl = this.buffer.indexOf('\n')
    }
    callback()
  }

  _flush(callback: TransformCallback): void {
    // 上游结束：处理残留的未换行数据（可能是一条被截断的 data: 行）
    if (this.buffer.length > 0) {
      const leftover = this.buffer
      this.buffer = ''
      this.processLine(leftover)
    }
    // 无论是否见过 [DONE]，都以完整收尾事件序列结束，保证事件结构完整
    this.finalize()
    callback()
  }

  /** 处理一条完整行（已去除 \n 终止符）：空行 / 非 data: 行忽略 */
  private processLine(raw: string): void {
    // 兼容 CRLF：去掉行尾 \r
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // 空行：SSE 事件分隔符，忽略
    if (line.length === 0) {
      return
    }
    // 只处理 data: 行，其余（event: / 注释等）一律忽略
    if (!line.startsWith('data: ')) {
      return
    }
    const payload = line.slice(6)
    if (payload === '[DONE]') {
      // 结束标记：输出收尾事件序列并终止流
      this.finalize()
      return
    }
    // 内容块：解析失败则告警并跳过（继续后续块，不中断）
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch (err) {
      getLogger().warn({ err }, 'responses stream parse chunk error')
      return
    }
    // usage 捕获：最后一次 usage 块生效（覆盖先前的快照）
    const usage = extractUsage(chunk)
    if (usage !== null) {
      this.usage = usage
    }
    // 内容为空的行（usage 块等）不输出 delta 事件
    const delta = extractDeltaContent(chunk)
    if (delta.length === 0) {
      return
    }
    // 首个 delta 前先输出 opening 事件序列（created → ... → content_part.added）
    this.emitOpenEvents()
    this.text += delta
    this.pushEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      delta,
    })
  }

  /** 输出 opening 事件序列：created → in_progress → output_item.added → content_part.added（只触发一次） */
  private emitOpenEvents(): void {
    if (this.opened) {
      return
    }
    this.opened = true
    const base = { id: this.respId, object: 'response', created_at: this.createdAt, model: this.model }
    this.pushEvent('response.created', { type: 'response.created', response: { ...base, status: 'in_progress' } })
    this.pushEvent('response.in_progress', { type: 'response.in_progress', response: { ...base, status: 'in_progress' } })
    this.pushEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: this.msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    })
    this.pushEvent('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
  }

  /** 输出收尾事件序列：output_text.done → content_part.done → output_item.done → response.completed（只触发一次） */
  private finalize(): void {
    if (this.finalized) {
      return
    }
    this.finalized = true
    // 空输出时也要先补 opening 事件序列，保证事件结构完整
    this.emitOpenEvents()
    const part: ResponsesOutputTextPart = { type: 'output_text', text: this.text, annotations: [] }
    this.pushEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      text: this.text,
    })
    this.pushEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: this.msgId,
      output_index: 0,
      content_index: 0,
      part,
    })
    const item: ResponsesOutputMessage = {
      type: 'message',
      id: this.msgId,
      role: 'assistant',
      status: 'completed',
      content: [part],
    }
    this.pushEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    })
    const response: ResponsesResponse = {
      id: this.respId,
      object: 'response',
      created_at: this.createdAt,
      status: 'completed',
      model: this.model,
      output: [item],
    }
    // 有 usage 才注入 response.completed（上游未返回则不产出该字段）
    if (this.usage !== null) {
      response.usage = this.usage
    }
    this.pushEvent('response.completed', { type: 'response.completed', response })
    this.push(null)
  }

  /** 输出一个 SSE 事件：event: <name> + data: <json> + 空行 */
  private pushEvent(name: string, data: unknown): void {
    this.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

/**
 * 创建上游 chat SSE → Responses SSE 的流式转换器。
 * @param upstreamStream 上游 OpenAI chat SSE 字节流（如 axios 响应流）
 * @param model 网关侧模型名（写入每个响应对象的 model 字段）
 * @returns Transform 流：写入侧接上游（由调用方 pipe），读取侧输出 Responses 事件
 */
export function createResponsesStream(upstreamStream: Readable, model: string): Readable {
  const transformer = new ChatToResponsesStream(model)
  // 传输层错误统一转成 error 事件后结束（不做重试）
  upstreamStream.on('error', (err) => {
    transformer.onUpstreamError(err)
  })
  return transformer
}

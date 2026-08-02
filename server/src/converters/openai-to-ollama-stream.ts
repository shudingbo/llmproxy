// OpenAI → Ollama 流式 chat 响应转换器（T15）
// 输入：OpenAI SSE 字节流（data: <json> / data: [DONE]）
// 输出：Ollama NDJSON 字节流（每行一个 JSON 对象，单 \n 结尾）
// 注意：不使用 8KB 尾部缓冲——usage 在实时块流中捕获（最后一次 usage 生效）
import { Transform } from 'node:stream'
import type { Readable, TransformCallback } from 'node:stream'
import { getLogger } from '../logger/index.js'

// 单条 usage 快照：只读 prompt_tokens / completion_tokens，其余字段（total_tokens 等）丢弃
interface UsageSnapshot {
  prompt_tokens?: number
  completion_tokens?: number
}

/**
 * 从 OpenAI 块中提取增量内容（choices[0].delta.content）。
 * 结构缺失 / 类型不符时返回空串，调用方据此跳过（绝不输出空内容行）。
 */
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

/**
 * 从 OpenAI 块中提取 usage 快照（顶层 chunk.usage）。
 * 仅记录数值类型的 prompt_tokens / completion_tokens，其余 usage 字段一律丢弃。
 */
function extractUsage(chunk: unknown): UsageSnapshot | null {
  if (typeof chunk !== 'object' || chunk === null) return null
  const usage = (chunk as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null) return null
  const record = usage as Record<string, unknown>
  const snapshot: UsageSnapshot = {}
  if (typeof record.prompt_tokens === 'number') {
    snapshot.prompt_tokens = record.prompt_tokens
  }
  if (typeof record.completion_tokens === 'number') {
    snapshot.completion_tokens = record.completion_tokens
  }
  return snapshot
}

/**
 * 流式转换器：逐行解析 OpenAI SSE，输出 Ollama NDJSON。
 * - 单条 data: 事件可能跨多个上游 chunk，用 buffer 累积原始字节
 * - 内容块解析失败 → warn + 跳过（不中断流）；传输错误 → 输出一行 { error } 后结束
 * - 结束行（done: true）保证只输出一次，且无 usage 时也要输出
 */
class OpenAIToOllamaStream extends Transform {
  // 跨 chunk 累积的原始字节（未遇到 \n 的行留在这里等待拼接）
  private buffer = ''
  // 最后一次看到的 usage（后到覆盖先到）
  private lastUsage: UsageSnapshot | null = null
  // 是否已输出结束行（防止重复输出 done: true）
  private doneEmitted = false

  constructor(private readonly model: string) {
    // 双端字节模式：写入侧收 SSE 字节流，读取侧吐 NDJSON 字节流
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  /** 上游传输错误（TCP 重置 / 非 2xx 等）：输出一行 { error } 后结束，不做重试 */
  onUpstreamError(err: unknown): void {
    if (this.doneEmitted) {
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    this.doneEmitted = true
    this.push(JSON.stringify({ error: message }) + '\n')
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
    // 无论是否见过 [DONE]，都以唯一一行 done: true 收尾，保证输出结构完整
    this.emitFinalLine()
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
      // 结束标记：输出最终行并终止流
      this.emitFinalLine()
      return
    }
    // 内容块：解析失败则告警并跳过（继续后续块，不中断）
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch (err) {
      getLogger().warn({ err }, 'parse chunk error')
      return
    }
    // usage 捕获：最后一次 usage 块生效（覆盖先前的快照）
    const usage = extractUsage(chunk)
    if (usage !== null) {
      this.lastUsage = usage
    }
    // 内容为空的行不输出（usage 块通常无内容）
    const content = extractDeltaContent(chunk)
    if (content.length === 0) {
      return
    }
    this.pushLine({
      model: this.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content },
      done: false,
    })
  }

  /** 输出结束行：done: true + done_reason: 'stop'，有 usage 时附加 token 计数字段 */
  private emitFinalLine(): void {
    if (this.doneEmitted) {
      return
    }
    this.doneEmitted = true
    const line: Record<string, unknown> = {
      model: this.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
    }
    // 无 usage 时省略 token 计数字段（done: true 仍照常输出）
    if (this.lastUsage !== null) {
      if (typeof this.lastUsage.prompt_tokens === 'number') {
        line.prompt_eval_count = this.lastUsage.prompt_tokens
      }
      if (typeof this.lastUsage.completion_tokens === 'number') {
        line.eval_count = this.lastUsage.completion_tokens
      }
    }
    this.pushLine(line)
  }

  /** 输出一行 NDJSON（单 \n 结尾，不用 \n\n） */
  private pushLine(obj: unknown): void {
    this.push(JSON.stringify(obj) + '\n')
  }
}

/**
 * 创建 OpenAI SSE → Ollama NDJSON 的流式转换器。
 * @param upstreamStream 上游 OpenAI SSE 字节流（如 axios 响应流）
 * @param model 转发的模型名（写入每条输出的 model 字段）
 * @returns Transform 流：写入侧接上游，读取侧逐行输出 NDJSON
 */
export function createOpenAIToOllamaStream(upstreamStream: Readable, model: string): Readable {
  const transformer = new OpenAIToOllamaStream(model)
  // 传输层错误统一转成一行 { error } NDJSON 后结束（不做重试）
  upstreamStream.on('error', (err) => {
    transformer.onUpstreamError(err)
  })
  return transformer
}

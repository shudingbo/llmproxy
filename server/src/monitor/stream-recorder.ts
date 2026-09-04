// assistant 流式记录器：解析上游 SSE 流，实时回调 delta 事件并累积完整文本
// 两种解析口径（与网关对接的上游流格式一一对应）：
//   - 'chat'      OpenAI chat completions SSE：data: {choices: [{delta: {content}}]}（/ [DONE]）
//   - 'responses' OpenAI Responses SSE：data: {type: 'response.output_text.delta', delta}
//                 （含网关 convert 路径 createResponsesStream 产出的同形事件流）
//
// 本模块只负责"解析 + 累积 + 回调"，绝不落库、不碰订阅总线（那是 SessionMonitor 门面的职责）；
// delta 按 token 级频率回调，纯内存操作，成本可忽略。
//
// 鲁棒性约定（与 responses 探测解析同风格）：
//   - 单条 SSE 行可能跨多个 chunk：内部 buffer 按 \n 切完整行处理，残片留待下一 chunk
//   - 非 data: 行（event: / 注释 / 空行）一律忽略
//   - 非 JSON 的 data 行静默跳过（不断流、不抛错）
//   - [DONE] 哨兵终止语义由上游流的 end/close 事件表达，本模块不特判
export type RecorderKind = 'chat' | 'responses'

// 最小 chat SSE chunk 结构（只取首 choice 的 delta.content，其余字段忽略）
interface ChatSseChunk {
  choices?: Array<{ delta?: { content?: unknown } }>
}

// 最小 Responses SSE 事件结构（只关心 output_text.delta / output_text.done）
interface ResponsesSseEvent {
  type?: string
  delta?: unknown
  text?: unknown
}

export class AssistantStreamRecorder {
  private readonly kind: RecorderKind
  private readonly onDelta: (content: string) => void
  // 跨 chunk 累积未换行的字节（单条 SSE 行可能跨多个 chunk）
  private buffer = ''
  // delta 累加的完整文本
  private content = ''
  // responses 口径兜底：上游未发 delta 只发 output_text.done（带全文）时的完整文本
  private fallbackText = ''
  private finished = false

  constructor(kind: RecorderKind, onDelta: (content: string) => void) {
    this.kind = kind
    this.onDelta = onDelta
  }

  // 喂入上游流的一个 chunk（Buffer 或 string）；finish 之后为 no-op
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

  // 结束（幂等）：之后 feed 不再处理。持久化由门面在 finish 回调中执行
  finish(): void {
    this.finished = true
  }

  // 累积的完整文本：delta 累加优先，空时回退 responses 的 done 全文
  getContent(): string {
    if (this.content !== '') {
      return this.content
    }
    return this.fallbackText
  }

  isFinished(): boolean {
    return this.finished
  }

  // 处理一条完整行（含 \r 兼容）：只认 data: 行，其余忽略
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
      return
    }
    if (this.kind === 'chat') {
      this.consumeChatChunk(evt)
    } else {
      this.consumeResponsesEvent(evt)
    }
  }

  private consumeChatChunk(evt: Record<string, unknown>): void {
    const delta = extractChatDelta(evt)
    if (delta !== '') {
      this.content += delta
      this.onDelta(delta)
    }
  }

  private consumeResponsesEvent(evt: Record<string, unknown>): void {
    const event = evt as ResponsesSseEvent
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta === 'string' && event.delta !== '') {
        this.content += event.delta
        this.onDelta(event.delta)
      }
    } else if (event.type === 'response.output_text.done') {
      // 兜底：仅当未收到任何 delta 时采用 done 的全文（正常上游两者一致，以 delta 累加为准）
      if (this.content === '' && typeof event.text === 'string' && event.text !== '') {
        this.fallbackText = event.text
      }
    }
  }
}

// 从 chat SSE chunk 提取首 choice 的增量文本；结构缺失 / 类型不符返回空串（调用方跳过）
function extractChatDelta(chunk: ChatSseChunk): string {
  const choice = chunk.choices?.[0]
  const content = choice?.delta?.content
  return typeof content === 'string' ? content : ''
}

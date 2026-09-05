// assistant 流式记录器：解析上游 SSE 流，实时回调 delta 事件并累积完整文本
// 两种解析口径（与网关对接的上游流格式一一对应）：
//   - 'chat'      OpenAI chat completions SSE：data: {choices: [{delta: {content, reasoning_content}}]}（/ [DONE]）
//   - 'responses' OpenAI Responses SSE：data: {type: 'response.output_text.delta', delta}
//                 （含网关 convert 路径 createResponsesStream 产出的同形事件流）
//
// 双通道（think / content）：推理模型（DeepSeek 等）先流式输出思考过程、再输出正文：
//   - 'chat'      思考 = delta.reasoning_content（增量，与 content 同一 choice，先于正文到达）
//                 或 delta.reasoning_details[].text（MiniMax reasoning_split 模式，text 为累计全文，
//                 记录器按已累积值做差取增量）
//   - 'responses' 思考 = response.reasoning_text.delta / response.reasoning_summary_text.delta
//                 （原生透传流；convert 路径的转换流不含思考事件——转换器以简单可靠为准，不携带）
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

// delta 通道：think = 思考/推理过程（reasoning_content），content = 正文
export type DeltaChannel = 'think' | 'content'

// 最小 chat SSE chunk 结构（只取首 choice 的 delta.content / 思考字段，其余字段忽略）
interface ChatSseChunk {
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning_details?: unknown } }>
}

// 最小 Responses SSE 事件结构（只关心 output_text / reasoning_text / reasoning_summary_text 的 delta / done）
interface ResponsesSseEvent {
  type?: string
  delta?: unknown
  text?: unknown
}

export class AssistantStreamRecorder {
  private readonly kind: RecorderKind
  private readonly onDelta: (channel: DeltaChannel, content: string) => void
  // 跨 chunk 累积未换行的字节（单条 SSE 行可能跨多个 chunk）
  private buffer = ''
  // 正文 delta 累加的完整文本
  private content = ''
  // 思考 delta 累加的完整文本
  private reasoning = ''
  // responses 口径兜底：上游未发 delta 只发 done（带全文）时的完整文本
  private fallbackText = ''
  private fallbackReasoning = ''
  private finished = false

  constructor(kind: RecorderKind, onDelta: (channel: DeltaChannel, content: string) => void) {
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

  // 累积的完整正文：delta 累加优先，空时回退 responses 的 done 全文
  getContent(): string {
    if (this.content !== '') {
      return this.content
    }
    return this.fallbackText
  }

  // 累积的完整思考文本（无思考内容时为空串；同上 done 全文兜底）
  getReasoning(): string {
    if (this.reasoning !== '') {
      return this.reasoning
    }
    return this.fallbackReasoning
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
    const { content, reasoning } = this.extractChatDelta(evt)
    if (reasoning !== '') {
      this.reasoning += reasoning
      this.onDelta('think', reasoning)
    }
    if (content !== '') {
      this.content += content
      this.onDelta('content', content)
    }
  }

  // 从 chat SSE chunk 提取首 choice 的增量正文 / 思考文本；结构缺失 / 类型不符返回空串（调用方跳过）
  // 思考有两种载体：
  // - delta.reasoning_content：增量（DeepSeek 等推理模型；与 content 同一 choice，先于正文到达）
  // - delta.reasoning_details[].text：累计全文（MiniMax reasoning_split 模式），
  //   以已累积的思考文本为基线做差取增量（两种载体互斥，增量字段优先）
  private extractChatDelta(chunk: ChatSseChunk): { content: string; reasoning: string } {
    const delta = chunk.choices?.[0]?.delta
    if (delta === undefined || delta === null) {
      return { content: '', reasoning: '' }
    }
    const content = typeof delta.content === 'string' ? delta.content : ''
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      return { content, reasoning: delta.reasoning_content }
    }
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
      // 取最长元素作为累计快照（通常仅 1 个元素）
      let snapshot = ''
      for (const item of delta.reasoning_details) {
        if (typeof item === 'object' && item !== null) {
          const text = (item as { text?: unknown }).text
          if (typeof text === 'string' && text.length > snapshot.length) {
            snapshot = text
          }
        }
      }
      // 仅当快照是已累积文本的延伸时接受（防御乱序 / 重置，避免脏数据）
      if (snapshot.length > this.reasoning.length && (this.reasoning === '' || snapshot.startsWith(this.reasoning))) {
        return { content, reasoning: snapshot.slice(this.reasoning.length) }
      }
    }
    return { content, reasoning: '' }
  }

  private consumeResponsesEvent(evt: Record<string, unknown>): void {
    const event = evt as ResponsesSseEvent
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta === 'string' && event.delta !== '') {
        this.content += event.delta
        this.onDelta('content', event.delta)
      }
    } else if (event.type === 'response.output_text.done') {
      // 兜底：仅当未收到任何 delta 时采用 done 的全文（正常上游两者一致，以 delta 累加为准）
      if (this.content === '' && typeof event.text === 'string' && event.text !== '') {
        this.fallbackText = event.text
      }
    } else if (event.type === 'response.reasoning_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta === 'string' && event.delta !== '') {
        this.reasoning += event.delta
        this.onDelta('think', event.delta)
      }
    } else if (event.type === 'response.reasoning_text.done' || event.type === 'response.reasoning_summary_text.done') {
      // 思考全文兜底：同 output_text.done 语义（仅未收到任何思考 delta 时采用）
      if (this.reasoning === '' && typeof event.text === 'string' && event.text !== '') {
        this.fallbackReasoning = event.text
      }
    }
  }
}

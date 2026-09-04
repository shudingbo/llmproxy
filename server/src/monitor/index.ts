// 会话消息监控门面：记录（SQLite 持久化）+ 实时推送（内存订阅总线）
//
// 数据流：
//   下游请求（/v1/chat/completions、/v1/responses、/api/chat）→ 路由层 tap 点调用：
//     - recordRequest：请求侧消息逐条去重落库（多轮重发的历史只存一次），新写入即推送
//     - createAssistantRecorder：流式回答挂接记录器，SSE delta 实时推送（token 级，不落库），
//       流结束 / 中断后整条落库一次并推送 assistant_done
//     - recordAssistant / recordChatResponse / recordResponsesResponse：非流式回答整条落库 + 推送
//   管理端 SSE 端点（admin.ts）→ subscribe(sessionKey) 收事件流：历史 + 实时
//
// 失败隔离（与日志双写同契约）：DB 写失败仅告警一次，绝不影响业务请求；
// 订阅者异常（如 socket 写失败）自动摘除，不影响其它订阅者与业务
import { randomBytes } from 'node:crypto'
import { getLogger } from '../logger/index.js'
import { SessionMessageStore, type SessionMessageRow } from './db.js'
import { AssistantStreamRecorder, type RecorderKind } from './stream-recorder.js'

// 推送事件（管理端 SSE 端点原样序列化为 data: 行）：
// - message：一条完整消息（历史回放 / 请求侧新写入 / 非流式 assistant）
// - assistant_delta：流式增量（token 级，不落库；id 为该轮流式块的临时键）
// - assistant_done：流式结束（content 为完整文本：中途订阅者可凭此补块；finalId 为落库行 id，空内容时为 null）
export type MonitorEvent =
  | { type: 'message'; id: number; role: string; content: string; at: number }
  | { type: 'assistant_delta'; id: string; content: string }
  | { type: 'assistant_done'; id: string; finalId: number | null; content: string; at: number; truncated: boolean }

export type MonitorEventListener = (event: MonitorEvent) => void

// 流式记录器句柄：路由层在拿到上游流后逐 chunk feed；finish 幂等，aborted=true 表示中断（truncated）
export interface AssistantStreamHandle {
  feed(chunk: Buffer | string): void
  finish(aborted?: boolean): void
}

// 无会话键 / 未注入监控时的零开销空实现
const NOOP_HANDLE: AssistantStreamHandle = { feed: () => {}, finish: () => {} }

// 单条消息归一化：提取 [role, content]（与 session/key.ts 的 serializeMessage 同口径）——
// role 缺失 → 空串；content 字符串原样、缺失 → 空串；null / 对象 / 多模态数组 → JSON.stringify
// role 与 content 均为空 → null（空消息跳过）
const normalizeMessage = (m: unknown): { role: string; content: string } | null => {
  const msg = (m ?? {}) as Record<string, unknown>
  const role = typeof msg.role === 'string' ? msg.role : ''
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content === undefined
        ? ''
        : JSON.stringify(msg.content)
  if (role === '' && content === '') {
    return null
  }
  return { role, content }
}

export class SessionMonitor {
  private readonly store: SessionMessageStore
  private readonly subscribers = new Map<string, Set<MonitorEventListener>>()
  // DB 写失败仅告警一次（后续同类失败静默，避免日志风暴）
  private writeFailed = false

  constructor(dbPath: string) {
    this.store = new SessionMessageStore(dbPath)
  }

  // 请求侧记录：逐条去重落库；新写入（历史中不存在）按请求内顺序推送 message 事件。
  // sessionKey 缺失（无会话请求）或 messages 非数组 → no-op
  recordRequest(sessionKey: string | undefined, messages: unknown): void {
    if (sessionKey === undefined || !Array.isArray(messages)) {
      return
    }
    for (const raw of messages) {
      const msg = normalizeMessage(raw)
      if (msg === null) {
        continue
      }
      try {
        const row = this.store.insertDedup(sessionKey, msg.role, msg.content)
        if (row !== null) {
          this.emit(sessionKey, { type: 'message', id: row.id, role: row.role, content: row.content, at: row.created_at })
        }
      } catch (err) {
        this.reportWriteError(err, '请求消息记录失败')
      }
    }
  }

  // 流式回答记录器：kind 标识上游 SSE 口径（chat / responses）。
  // sessionKey 缺失 → 空实现句柄（零开销）；
  // delta 经内存总线实时推送（不落库）；finish 时整条落库并推送 assistant_done
  createAssistantRecorder(sessionKey: string | undefined, kind: RecorderKind): AssistantStreamHandle {
    if (sessionKey === undefined) {
      return NOOP_HANDLE
    }
    const nonce = `a${randomBytes(6).toString('hex')}`
    let finished = false
    const recorder = new AssistantStreamRecorder(kind, (delta) => {
      this.emit(sessionKey, { type: 'assistant_delta', id: nonce, content: delta })
    })
    return {
      feed: (chunk: Buffer | string) => {
        recorder.feed(chunk)
      },
      finish: (aborted = false) => {
        if (finished) {
          return
        }
        finished = true
        recorder.finish()
        const content = recorder.getContent()
        let finalId: number | null = null
        if (content !== '') {
          try {
            const row = this.store.insert(sessionKey, 'assistant', content)
            finalId = row.id
          } catch (err) {
            this.reportWriteError(err, 'assistant 消息记录失败')
          }
        }
        this.emit(sessionKey, {
          type: 'assistant_done',
          id: nonce,
          finalId,
          content,
          at: Date.now(),
          truncated: aborted,
        })
      },
    }
  }

  // 非流式 assistant 回答直接记录（空内容 no-op）：整条落库 + 推送 message 事件
  recordAssistant(sessionKey: string | undefined, content: string): void {
    if (sessionKey === undefined || content === '') {
      return
    }
    try {
      const row = this.store.insert(sessionKey, 'assistant', content)
      this.emit(sessionKey, { type: 'message', id: row.id, role: 'assistant', content: row.content, at: row.created_at })
    } catch (err) {
      this.reportWriteError(err, 'assistant 消息记录失败')
    }
  }

  // chat 非流式响应记录：逐 choice 提取 message 内容（content 缺失时回退 tool_calls JSON）
  recordChatResponse(sessionKey: string | undefined, data: unknown): void {
    const body = data as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> } | null
    if (sessionKey === undefined || body === null || typeof body !== 'object' || !Array.isArray(body.choices)) {
      return
    }
    for (const choice of body.choices) {
      const message = choice?.message
      if (message === undefined || message === null) {
        continue
      }
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.tool_calls !== undefined && message.tool_calls !== null
            ? JSON.stringify(message.tool_calls)
            : ''
      this.recordAssistant(sessionKey, content)
    }
  }

  // Responses 非流式响应记录：提取 output 中 type=message 项的文本（多 content part 按序拼接）
  recordResponsesResponse(sessionKey: string | undefined, data: unknown): void {
    const body = data as {
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
    } | null
    if (sessionKey === undefined || body === null || typeof body !== 'object' || !Array.isArray(body.output)) {
      return
    }
    for (const item of body.output) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) {
        continue
      }
      const text = item.content
        .filter((part) => part !== null && typeof part === 'object' && typeof part.text === 'string')
        .map((part) => (part as { text: string }).text)
        .join('')
      this.recordAssistant(sessionKey, text)
    }
  }

  // 订阅某会话的事件流；返回退订函数（幂等）
  subscribe(sessionKey: string, listener: MonitorEventListener): () => void {
    let set = this.subscribers.get(sessionKey)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(sessionKey, set)
    }
    set.add(listener)
    return () => {
      const current = this.subscribers.get(sessionKey)
      if (current === undefined) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        this.subscribers.delete(sessionKey)
      }
    }
  }

  // 推送（同步）：遍历快照，订阅者异常自动摘除
  private emit(sessionKey: string, event: MonitorEvent): void {
    const set = this.subscribers.get(sessionKey)
    if (set === undefined || set.size === 0) {
      return
    }
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch (err) {
        set.delete(listener)
        getLogger().debug({ err }, '会话监控订阅者异常，已自动摘除')
      }
    }
  }

  // 查询（管理端 SSE 端点历史回放用）
  list(sessionKey: string, limit?: number): SessionMessageRow[] {
    return this.store.list(sessionKey, limit)
  }

  count(sessionKey: string): number {
    return this.store.count(sessionKey)
  }

  // 清理原语（装配层调度 + 管理端会话删除路由级联用）
  deleteBySession(sessionKey: string): number {
    return this.store.deleteBySession(sessionKey)
  }

  deleteOrphaned(): number {
    return this.store.deleteOrphaned()
  }

  deleteExpired(maxAgeMs: number): number {
    return this.store.deleteExpired(maxAgeMs)
  }

  deleteAll(): number {
    return this.store.deleteAll()
  }

  close(): void {
    this.store.close()
  }

  // DB 写失败仅告警一次（与日志双写的隔离契约一致）
  private reportWriteError(err: unknown, context: string): void {
    if (this.writeFailed) {
      return
    }
    this.writeFailed = true
    getLogger().warn({ err }, `${context}（后续同类错误不再告警）`)
  }
}

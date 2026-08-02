// OpenAI → Ollama 非流式 chat 响应转换器（T14）
// 仅负责非流式响应的字段映射；流式转换由 T15 负责，本文件不涉及流
import { getLogger } from '../logger/index.js'

// Ollama 非流式 chat 响应（https://docs.ollama.com/api/chat）
// 只声明本转换器产出的字段；duration 系列字段暂不产出，后续需要时再扩展
export interface OllamaChatResponse {
  model: string
  // ISO 8601 时间戳
  created_at: string
  message: {
    role: string
    content: string
  }
  done: boolean
  // 结束原因：'stop' 正常结束 / 'length' 达到 max_tokens；未知时省略该字段
  done_reason?: 'stop' | 'length'
  // OpenAI prompt_tokens → Ollama prompt_eval_count
  prompt_eval_count?: number
  // OpenAI completion_tokens → Ollama eval_count
  eval_count?: number
}

/**
 * OpenAI 结束原因 → Ollama 结束原因。
 * 'stop' / 'length' 原样映射；其他值（含 undefined / 未知值）返回 null，
 * 调用方据此省略 done_reason 字段。
 */
export function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | null {
  if (reason === 'stop' || reason === 'length') return reason
  return null
}

/**
 * OpenAI 非流式 chat 响应 → Ollama 非流式 chat 响应。
 * - created 为 unix 秒，×1000 后转 ISO 8601；缺失时回退当前时间
 * - 调用方（T17）在进入本函数前已拒绝 n > 1，因此这里只取 choices[0]
 * - choices 为空时抛错，不产出半成品响应
 * - 只读取入参，绝不修改输入对象；无任何回退 / 重试逻辑
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上游响应结构动态，按计划约定签名
export function convertChatResponse(openaiResp: any, model: string): OllamaChatResponse {
  const choices = openaiResp?.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('choices empty')
  }
  const choice = choices[0]
  const message = choice?.message

  // tool_calls 存在时告警并丢弃（本代理不支持工具调用，不转发给 Ollama）
  if (message?.tool_calls !== undefined) {
    const count = Array.isArray(message.tool_calls) ? message.tool_calls.length : 1
    getLogger().warn({ toolCallCount: count }, 'openai 响应包含 tool_calls，本代理不支持，已丢弃')
  }

  // created 为 unix 秒；缺失（null/undefined）时用当前 unix 秒回退
  const createdSec = openaiResp.created ?? Math.floor(Date.now() / 1000)
  const createdAt = new Date(createdSec * 1000).toISOString()

  // 构建响应：message 只取 role/content，tool_calls 天然被剥离（不修改入参）
  const result: OllamaChatResponse = {
    model,
    created_at: createdAt,
    message: {
      role: 'assistant',
      content: message?.content || '',
    },
    done: true,
  }

  // 结束原因仅在可映射时写出，未知原因省略该字段
  const doneReason = mapFinishReason(choice?.finish_reason)
  if (doneReason !== null) {
    result.done_reason = doneReason
  }

  // usage 映射：prompt_tokens → prompt_eval_count，completion_tokens → eval_count
  const usage = openaiResp?.usage
  if (usage != null && typeof usage === 'object') {
    if (typeof usage.prompt_tokens === 'number') {
      result.prompt_eval_count = usage.prompt_tokens
    }
    if (typeof usage.completion_tokens === 'number') {
      result.eval_count = usage.completion_tokens
    }
  }

  return result
}

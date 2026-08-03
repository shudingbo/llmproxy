// Chat Completions → Responses 响应转换器（非流式）
// 把上游 chat 非流式响应体转换为 OpenAI Responses 响应对象（POST /v1/responses 的回包）
// 只做字段映射与丢弃，绝不修改入参
import { nanoid } from 'nanoid'
import type { UpstreamChatResponse } from '../upstream/openai.js'
import type {
  ResponsesOutputMessage,
  ResponsesOutputTextPart,
  ResponsesResponse,
  ResponsesUsage,
} from './responses-types.js'

// 提取输出文本：choices[0].message.content（null / 缺失 / 非字符串 → 空串）
// reasoning_content 等附加字段忽略（以简单可靠为准）
const extractOutputText = (chatRes: UpstreamChatResponse): string => {
  const content = chatRes.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

// chat usage → responses usage：字段改名（prompt_tokens → input_tokens 等），缺省为 0
const mapUsage = (chatRes: UpstreamChatResponse): ResponsesUsage | undefined => {
  const usage = chatRes.usage
  if (usage === undefined) {
    return undefined
  }
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  }
}

/**
 * 非流式响应转换：chat 响应体 → Responses 响应对象。
 * @param chatRes 上游 chat 响应体（UpstreamChatResponse）
 * @param model 网关侧模型名（下游别名，与 /v1/chat/completions 一致）
 */
export function chatResponseToResponses(chatRes: UpstreamChatResponse, model: string): ResponsesResponse {
  const text = extractOutputText(chatRes)
  const part: ResponsesOutputTextPart = { type: 'output_text', text, annotations: [] }
  const message: ResponsesOutputMessage = {
    type: 'message',
    id: `msg_${nanoid()}`,
    role: 'assistant',
    status: 'completed',
    content: [part],
  }
  const response: ResponsesResponse = {
    id: `resp_${nanoid()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [message],
  }
  // 上游无 usage 时省略该字段（与 OpenAI 缺省行为兼容）
  const usage = mapUsage(chatRes)
  if (usage !== undefined) {
    response.usage = usage
  }
  return response
}

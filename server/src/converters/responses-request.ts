// Responses → Chat Completions 请求转换器
// 把下游（客户端发来的）POST /v1/responses 请求体转换为上游 chat 请求体（UpstreamChatRequest）
// 只做字段映射与丢弃，绝不修改入参；未知/无关字段一律不产出
import type { UpstreamChatRequest } from '../upstream/openai.js'
import type { ResponsesRequest } from './responses-types.js'

// 上游 chat 消息：只保留 role/content（字符串）
export interface ResponsesChatMessage {
  role: string
  content: string
}

// 透传白名单：这些采样参数与 chat 接口同构，原样透传进上游请求体
const PASSTHROUGH_KEYS = [
  'temperature',
  'top_p',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'response_format',
  'prompt_cache_key'
] as const

// instructions 存在且非空 → 前置 system 消息；否则缺省
const instructionsMessage = (body: ResponsesRequest): ResponsesChatMessage | undefined => {
  if (typeof body.instructions !== 'string' || body.instructions.length === 0) {
    return undefined
  }
  return { role: 'system', content: body.instructions }
}

// content 归一化为字符串：
// - 字符串原样透传
// - 数组（多模态片段）取各片段 text 字段按换行拼接（input_text/output_text/text 均可命中）
// - 其余（缺失 / 对象等）→ 空串
const normalizeContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      const record = part as Record<string, unknown> | null
      if (record !== null && typeof record === 'object' && typeof record.text === 'string') {
        texts.push(record.text)
      }
    }
    return texts.join('\n')
  }
  return ''
}

// 单条输入项 → chat 消息：仅带 role 的项（{role, content} 或 {type:'message', role, content}）可映射；
// 其余项（function_call / function_call_output / reasoning 等）返回 undefined 由调用方跳过
const mapInputItem = (item: unknown): ResponsesChatMessage | undefined => {
  if (typeof item !== 'object' || item === null) {
    return undefined
  }
  const record = item as Record<string, unknown>
  if (typeof record.role !== 'string' || record.role.length === 0) {
    return undefined
  }
  return { role: record.role, content: normalizeContent(record.content) }
}

// 单条工具转换：Responses 扁平 function 工具（{type, name, description, parameters, ...}）
// → chat 嵌套形状（{type: 'function', function: {name, description, parameters, ...}}）；
// 其余字段（除 type 外）按原顺序收进 function；非 function 类型（custom / web_search 等）
// 原样保留，由上游决定是否忽略。返回新对象，绝不修改入参
const convertTool = (tool: unknown): unknown => {
  if (typeof tool !== 'object' || tool === null) {
    return tool
  }
  const record = tool as Record<string, unknown>
  if (record.type !== 'function') {
    return tool
  }
  // 除 type 外其余字段按原顺序收进 function（Object.entries 保持插入顺序）
  const fn: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type') {
      fn[key] = value
    }
  }
  return { type: 'function', function: fn }
}

// tool_choice 转换：Responses 对象形状 {type: 'function', name} → chat 嵌套
// {type: 'function', function: {name}}；字符串（auto / none / required）原样透传
const convertToolChoice = (toolChoice: unknown): unknown => {
  if (typeof toolChoice !== 'object' || toolChoice === null) {
    return toolChoice
  }
  const record = toolChoice as Record<string, unknown>
  if (record.type === 'function' && typeof record.name === 'string') {
    return { type: 'function', function: { name: record.name } }
  }
  return toolChoice
}

/**
 * 把 Responses 请求体的 input/instructions 转换为 chat messages：
 * - instructions 存在 → 前置 system 消息
 * - input 为字符串 → 追加 user 消息
 * - input 为数组 → 逐项映射（仅带 role 的项），其余忽略
 */
export function responsesToChatMessages(body: ResponsesRequest): ResponsesChatMessage[] {
  const messages: ResponsesChatMessage[] = []
  const system = instructionsMessage(body)
  if (system !== undefined) {
    messages.push(system)
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const msg = mapInputItem(item)
      if (msg !== undefined) {
        messages.push(msg)
      }
    }
  }
  return messages
}

/**
 * 整个请求体转换：Responses → chat（model 原样带出，由网关处理器改写为上游侧模型名）。
 * - messages 由 responsesToChatMessages 产出
 * - max_output_tokens → max_tokens（Responses 参数名到 chat 参数名的映射）
 * - stream 与 body.stream 一致（网关处理器会按分支强制为 true/false）
 * - tools / tool_choice 转换后透传（保持工具顺序；结构扁平 → 嵌套）
 * - 其余白名单字段（temperature/top_p 等）原样透传
 * 输出字段顺序固定：model → messages → stream → tools → tool_choice → max_tokens → 白名单
 * （对象按构造顺序插入，对 JSON 序列化与顺序敏感消费方可预测）
 */
export function responsesRequestToChat(body: ResponsesRequest): UpstreamChatRequest {
  const chat: UpstreamChatRequest = {
    model: body.model,
    messages: responsesToChatMessages(body),
    stream: body.stream === true,
  }
  // tools 逐项转换（保序），仅数组且非空时注入
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools.map(convertTool)
  }
  if (body.tool_choice !== undefined) {
    chat.tool_choice = convertToolChoice(body.tool_choice)
  }
  if (typeof body.max_output_tokens === 'number') {
    chat.max_tokens = body.max_output_tokens
  }
  for (const key of PASSTHROUGH_KEYS) {
    const value = (body as Record<string, unknown>)[key]
    if (value !== undefined) {
      chat[key] = value
    }
  }

  return chat
}

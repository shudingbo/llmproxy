// OpenAI → Ollama 聊天请求转换器（T13）
// 把下游（客户端发来的）OpenAI 格式 /v1/chat/completions 请求体转换为 Ollama /api/chat 请求体
// 参考 Ollama chat 契约：https://docs.ollama.com/api/chat
// 只做字段映射与丢弃，绝不修改入参；n > 1 的校验由调用方（T17）负责，本转换器不关心
import { getLogger } from '../logger/index.js'

// ---------- 输出：Ollama /api/chat 请求体 ----------

// Ollama 消息：只保留 role/content；多模态图片由顶层 images 字段承载
export interface OllamaChatMessage {
  role: string
  content: string
}

// Ollama 采样参数（由 OpenAI 参数名映射而来）
export interface OllamaChatOptions {
  temperature?: number
  top_p?: number
  stop?: string[]
  seed?: number
  num_predict?: number
}

// Ollama /api/chat 请求体（https://docs.ollama.com/api/chat）
export interface OllamaChatRequest {
  model: string
  messages: OllamaChatMessage[]
  // 'json'（json_object 模式）或 JSON Schema 对象（json_schema 模式）
  format?: string | Record<string, unknown>
  options?: OllamaChatOptions
  stream?: boolean
  // 多模态图片：纯 base64 字符串（或可直接访问的 URL），缺省时省略该字段
  images?: string[]
}

// ---------- 输入：OpenAI 格式请求（宽松结构，只声明本转换器关心的字段） ----------

// 多模态内容片段：文本或图片
export interface OpenAIContentPart {
  type?: string
  text?: string
  image_url?: { url?: string }
}

// OpenAI 消息：content 可以是字符串或多模态片段数组；name/tool_calls 等附加字段会被丢弃
export interface OpenAIMessage {
  role: string
  content?: string | OpenAIContentPart[]
  name?: string
  tool_calls?: unknown[]
  tool_call_id?: string
  function_call?: unknown
}

// OpenAI 聊天补全请求体（宽松结构，其余字段原样忽略）
export interface OpenAIChatRequest {
  model: string
  messages?: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  stop?: string | string[] | null
  seed?: number
  // Ollama 不支持这两个参数，声明仅为明确"静默丢弃"
  presence_penalty?: number
  frequency_penalty?: number
  max_tokens?: number
  response_format?: { type?: string; json_schema?: Record<string, unknown> } | null
  tools?: unknown[]
  [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 下游请求体结构动态，按计划约定签名
export function convertChatRequest(openaiReq: any): OllamaChatRequest {
  return convertTyped(openaiReq)
}

// 内部类型化实现：让字段拼写错误在编译期暴露（any 会掩盖这类问题）
function convertTyped(openaiReq: OpenAIChatRequest): OllamaChatRequest {
  // 多模态图片统一收集到顶层 images（去重），由消息转换逐条填充
  const images: string[] = []
  const seenImages = new Set<string>()
  const convertedMessages = (openaiReq.messages ?? []).map((msg) =>
    convertMessage(msg, images, seenImages),
  )

  // stream 透传，缺省为 false（与 Ollama 默认非流式一致）
  const request: OllamaChatRequest = {
    model: openaiReq.model,
    messages: convertedMessages,
    stream: openaiReq.stream ?? false,
  }

  // 收集到图片才输出 images 字段（无图请求保持字段缺省）
  if (images.length > 0) {
    request.images = images
  }

  const options = buildOptions(openaiReq)
  if (options !== undefined) {
    request.options = options
  }

  const format = resolveFormat(openaiReq.response_format)
  if (format !== undefined) {
    request.format = format
  }

  // v1 限制：Ollama 不支持工具调用，请求级 tools 直接丢弃并记 info
  if (openaiReq.tools !== undefined) {
    getLogger().info('tools 字段不受支持（v1 限制），已忽略')
  }

  return request
}

/** 单条消息转换：保留 role/content，丢弃其余字段；tool_calls 存在时记 warn */
function convertMessage(
  msg: OpenAIMessage,
  images: string[],
  seenImages: Set<string>,
): OllamaChatMessage {
  if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
    getLogger().warn('消息中的 tool_calls 字段不受支持（v1 限制），已忽略')
  }
  // content 为字符串时原样保留（缺省为空串）；为数组时走多模态拼接
  const content = Array.isArray(msg.content)
    ? convertMultimodalContent(msg.content, images, seenImages)
    : (msg.content ?? '')
  return { role: msg.role, content }
}

/**
 * 多模态内容数组转换：
 * - 文本片段按 \n 连接成单个 content 字符串
 * - 图片片段收集进 images（去重）；data: 前缀（base64 data URL）剥离，其余原样透传
 */
function convertMultimodalContent(
  parts: OpenAIContentPart[],
  images: string[],
  seenImages: Set<string>,
): string {
  const texts: string[] = []
  for (const part of parts) {
    if (part.type === 'image_url') {
      const url = part.image_url?.url
      if (typeof url === 'string' && url.length > 0) {
        const normalized = normalizeImageUrl(url)
        if (!seenImages.has(normalized)) {
          seenImages.add(normalized)
          images.push(normalized)
        }
      }
    } else if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
    }
  }
  return texts.join('\n')
}

/**
 * 归一化图片地址：
 * - data:image/png;base64,XXXX → 剥离前缀只留 XXXX（Ollama images 字段要求纯 base64）
 * - 其余情况原样透传（视为普通 URL 或已编码的 base64）
 */
function normalizeImageUrl(url: string): string {
  if (!url.startsWith('data:')) return url
  const commaIndex = url.indexOf(',')
  return commaIndex >= 0 ? url.slice(commaIndex + 1) : url.slice('data:'.length)
}

/** 采样参数映射：temperature/top_p/stop/seed → options；max_tokens → options.num_predict */
function buildOptions(openaiReq: OpenAIChatRequest): OllamaChatOptions | undefined {
  const options: OllamaChatOptions = {}
  let hasAny = false
  if (openaiReq.temperature !== undefined) {
    options.temperature = openaiReq.temperature
    hasAny = true
  }
  if (openaiReq.top_p !== undefined) {
    options.top_p = openaiReq.top_p
    hasAny = true
  }
  const stop = normalizeStop(openaiReq.stop)
  if (stop !== undefined) {
    options.stop = stop
    hasAny = true
  }
  if (openaiReq.seed !== undefined) {
    options.seed = openaiReq.seed
    hasAny = true
  }
  if (openaiReq.max_tokens !== undefined) {
    options.num_predict = openaiReq.max_tokens
    hasAny = true
  }
  // presence_penalty / frequency_penalty：Ollama 无对应参数，静默丢弃
  return hasAny ? options : undefined
}

/** stop 归一化为字符串数组（OpenAI 允许单个字符串或字符串数组） */
function normalizeStop(stop: string | string[] | null | undefined): string[] | undefined {
  if (stop === undefined || stop === null) return undefined
  return Array.isArray(stop) ? stop : [stop]
}

/**
 * response_format 映射：
 * - { type: 'json_object' } → format: 'json'
 * - { type: 'json_schema', json_schema: {...} } → format: <json_schema 对象>（Ollama 接受 JSON Schema 作为 format）
 * - 缺省或其它值 → 不输出 format 字段
 */
function resolveFormat(
  responseFormat: OpenAIChatRequest['response_format'],
): string | Record<string, unknown> | undefined {
  if (responseFormat === undefined || responseFormat === null) return undefined
  if (responseFormat.type === 'json_object') return 'json'
  if (responseFormat.type === 'json_schema' && responseFormat.json_schema !== undefined) {
    return responseFormat.json_schema
  }
  return undefined
}

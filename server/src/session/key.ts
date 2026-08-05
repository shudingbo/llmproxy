// 会话键提取模块：为会话亲和路由提供会话键（同一会话请求粘附同一上游，利用 LLM prompt cache）
// 职责：只做"提取"，不碰 HTTP 响应、不碰配置；消费方自行拼接 `${downstreamModel}::${raw}` 作为会话键
import { createHash } from 'node:crypto'
import type { Request } from 'express'

// 会话键提取结果：raw 为原始会话键值（header 值或内容 hash 十六进制），client 标记来源
export interface SessionKeyResult {
  raw: string
  client: 'open-webui' | 'x-session-id' | 'ywnrs' | 'content-hash'
}

// header 名大小写不敏感查找（Express 已将 header 名小写化，此处兜底直接构造的请求对象）
const findHeaderValue = (req: Request, name: string): string | undefined => {
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (key.toLowerCase() !== lowerName) {
      continue
    }
    // header 值可能为 string[]（重复 header），取第一个
    if (typeof value === 'string') {
      return value
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0]
    }
  }
  return undefined
}

// 计算内容前缀 hash：取前 2 条消息的 [role, content] 二元组，
// content 字符串原样、字段缺失视为空串、null/多模态数组/对象用 JSON.stringify 参与哈希（区分不同内容）；
// JSON.stringify 后 sha256 十六进制；不序列化 id/timestamp 等多余字段，保证同前缀稳定
const hashContentPrefix = (body: Record<string, unknown>): string | undefined => {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length < 1) {
    return undefined
  }

  const prefix = messages.slice(0, 2).map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>
    const role = typeof msg.role === 'string' ? msg.role : ''
    // content 字符串原样；字段缺失（undefined）视为空串保持稳定；
    // null / 多模态数组 / 对象用 JSON.stringify 参与哈希（区分不同内容）
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content === undefined
          ? ''
          : JSON.stringify(msg.content)
    return [role, content]
  })

  return createHash('sha256').update(JSON.stringify(prefix)).digest('hex')
}

/**
 * 提取会话键（优先级从高到低，返回第一个命中）：
 * 1. header X-OpenWebUI-Chat-Id 非空 → { raw: 值.trim(), client: 'open-webui' }
 * 2. header X-Session-Id 非空 → 值以 'ywnrs' 开头 → { raw: 值.trim(), client: 'ywnrs' }；
 *    否则 → { raw: 值.trim(), client: 'x-session-id' }
 * 3. body.messages 为数组且长度 ≥ 1 → 前 2 条内容前缀 sha256 → { raw: hashHex, client: 'content-hash' }
 * 4. 都不满足 → undefined（调用方走轮询兜底）
 */
export function extractSessionKey(
  req: Request, // express Request（只读 headers）
  body: Record<string, unknown>, // 已解析的请求体（JSON）
): SessionKeyResult | undefined {
  const openWebuiHeader = findHeaderValue(req, 'x-openwebui-chat-id')
  if (openWebuiHeader !== undefined ) {
    let trimmed = openWebuiHeader.trim()
    if( trimmed !== '' ) {
      return { raw: trimmed, client: 'open-webui' }
    }
  }

  // 通用会话头：部分 client 把 session id 放在 X-Session-Id；
  // 以 'ywnrs' 开头的值归类为独立的 ywnrs 客户端，便于运维按客户端来源筛选
  const sessionIdHeader = findHeaderValue(req, 'x-session-id')
  if (sessionIdHeader !== undefined ) {
    let trimmed = sessionIdHeader.trim()
    if( trimmed !== '' ) {
      return { raw: trimmed, client: trimmed.startsWith('ywnrs') ? 'ywnrs' : 'x-session-id' }
    }
  }

  const hashHex = hashContentPrefix(body)
  if (hashHex !== undefined) {
    return { raw: hashHex, client: 'content-hash' }
  }

  return undefined
}

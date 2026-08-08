// 会话键提取模块：为会话亲和路由提供会话键（同一会话请求粘附同一上游，利用 LLM prompt cache）
// 职责：只做"提取"，不碰 HTTP 响应、不碰配置；消费方自行拼接 `${downstreamModel}::${raw}` 作为会话键
import { createHash } from 'node:crypto'
import type { Request } from 'express'

// 会话来源客户端类型：extractSessionKey 各分支产生的 client 标记
// （字符串枚举：值即序列化后的字符串，DB 存储与前端展示不受影响）
export enum SessionClient {
  OpenWebUI = 'open-webui',
  XSessionId = 'x-session-id',
  Ywnrs = 'ywnrs',
  Github = 'github',
  ContentHash = 'content-hash',
  Unknown = 'unknown',
}

// 会话键提取结果：raw 为原始会话键值（header 值或内容 hash 十六进制），client 标记来源
export interface SessionKeyResult {
  raw: string
  client: SessionClient
}

// 一次性规范化请求头：构建「小写 key → 首个值」的 Map（header 值可能为 string[]，取第一个；
// 跳过空数组），供后续所有 header 查询 O(1) 复用；
// Express 已将 header 名小写化，此处兜底直接构造的请求对象
const normalizeHeaders = (req: Request): Map<string, string> => {
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    const lowerKey = key.toLowerCase()
    if (map.has(lowerKey)) {
      continue
    }
    // header 值可能为 string[]（重复 header），取第一个
    if (typeof value === 'string') {
      map.set(lowerKey, value)
    } else if (Array.isArray(value) && value.length > 0) {
      map.set(lowerKey, value[0])
    }
  }
  return map
}

// 从规范化后的 header Map 中按名查找（O(1)）；header 名大小写不敏感
const findHeaderValue = (headers: Map<string, string>, name: string): string | undefined =>
  headers.get(name.toLowerCase())

// 单条消息序列化：提取 [role, content] 二元组（content-hash 与 github 分支共用同一口径），
// content 字符串原样、字段缺失（undefined）视为空串保持稳定、
// null / 多模态数组 / 对象用 JSON.stringify 参与哈希（区分不同内容）
const serializeMessage = (m: unknown): [string, string] => {
  const msg = (m ?? {}) as Record<string, unknown>
  const role = typeof msg.role === 'string' ? msg.role : ''
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content === undefined
        ? ''
        : JSON.stringify(msg.content)
  return [role, content]
}

// 消息列表 → sha256 十六进制：序列化后 JSON.stringify 参与哈希，
// 不序列化 id/timestamp 等多余字段，保证同前缀稳定
const hashMessages = (messages: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(messages.map(serializeMessage))).digest('hex')

// 计算内容前缀 hash：取前 2 条消息的 [role, content] 二元组参与哈希；
// messages 缺失 / 非数组 / 为空返回 undefined
const hashContentPrefix = (body: Record<string, unknown>): string | undefined => {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length < 1) {
    return undefined
  }
  return hashMessages(messages.slice(0, 2))
}

// github 分支 hash：取「第 1 个 assistant 之前」的所有消息（不含该 assistant；
// 无 assistant 消息则取全部消息）计算 [role, content] 二元组 sha256；
// 理由：assistant 之前的消息即请求携带的完整上下文，随会话增长而追加 assistant/user 后不变
const hashBeforeFirstAssistant = (body: Record<string, unknown>): string | undefined => {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length < 1) {
    return undefined
  }
  const firstAssistantIndex = messages.findIndex((m) => {
    const msg = (m ?? {}) as Record<string, unknown>
    return msg.role === 'assistant'
  })

  const prefix = firstAssistantIndex === -1 ? messages : messages.slice(0, firstAssistantIndex);
  let msgT: any = [];
  for( let m of prefix ) {
    // 不知道为什么 vs 的 github copilot 会在会话的第二轮里在上次第一个user前插入新的包含 IDESTATE CONTEXT，所以这里过滤掉，
    if( m.role === "user" && m?.content?.indexOf("IDESTATE CONTEXT") >= 0 ) {
      continue
    }

    msgT.push(m)
  }

  return hashMessages(msgT)
}

/**
 * 提取会话键（优先级从高到低，返回第一个命中）：
 * 1. header X-OpenWebUI-Chat-Id 非空 → { raw: 值.trim(), client: 'open-webui' }
 * 2. header X-Session-Id 非空 → 值以 'ywnrs' 开头 → { raw: 值.trim(), client: 'ywnrs' }；
 *    否则 → { raw: 值.trim(), client: 'x-session-id' }
 * 3. header baggage 非空且值（转小写后）包含 'copilot'（GitHub Copilot 等 client）→
 *    第 1 个 assistant 之前的消息 sha256 → { raw: hashHex, client: 'github' }
 * 4. body.messages 为数组且长度 ≥ 1 → 前 2 条内容前缀 sha256 → { raw: hashHex, client: 'content-hash' }
 * 5. 都不满足 → undefined（调用方走轮询兜底）
 * header 查找方式：开头一次性把 req.headers 规范化为「小写 key → 首个值」的 Map，
 * 后续所有 header 查询均走该 Map（O(1)），避免重复全量遍历
 */
export function extractSessionKey(
  req: Request, // express Request（只读 headers）
  body: Record<string, unknown>, // 已解析的请求体（JSON）
): SessionKeyResult | undefined {
  const headers = normalizeHeaders(req)

  const openWebuiHeader = findHeaderValue(headers, 'x-openwebui-chat-id')
  if (openWebuiHeader !== undefined) {
    const trimmed = openWebuiHeader.trim()
    if (trimmed !== '') {
      return { raw: trimmed, client: SessionClient.OpenWebUI }
    }
  }

  // 通用会话头：部分 client 把 session id 放在 X-Session-Id；
  // 以 'ywnrs' 开头的值归类为独立的 ywnrs 客户端，便于运维按客户端来源筛选
  const sessionIdHeader = findHeaderValue(headers, 'x-session-id')
  if (sessionIdHeader !== undefined) {
    const trimmed = sessionIdHeader.trim()
    if (trimmed !== '') {
      return {
        raw: trimmed,
        client: trimmed.startsWith('ywnrs') ? SessionClient.Ywnrs : SessionClient.XSessionId,
      }
    }
  }

  // GitHub Copilot 等 client 分支：baggage 头携带 copilot 标识（如 vs.copilot.InitiatorType = user）；
  // 值转小写后包含 'copilot' 即命中，用「第 1 个 assistant 之前」的消息 hash 作为会话键
  const baggageHeader = findHeaderValue(headers, 'baggage')
  if (baggageHeader !== undefined && baggageHeader.toLowerCase().includes('copilot')) {
    const githubHash = hashBeforeFirstAssistant(body)
    if (githubHash !== undefined) {
      return { raw: githubHash, client: SessionClient.Github }
    }
  }

  const hashHex = hashContentPrefix(body)
  if (hashHex !== undefined) {
    return { raw: hashHex, client: SessionClient.ContentHash }
  }

  return undefined
}

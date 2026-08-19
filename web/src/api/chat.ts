import { api } from './client'

// ========== 聊天相关类型定义 ==========

// 聊天消息：content 可为纯文本或多模态内容片段（图片等）
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | ChatContentPart[]
  id?: string
}

// 多模态内容片段：目前支持文本与图片（data URL 或远程 URL）
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

// Chat Completions 流式请求体：stream 固定为 true（本模块只服务流式聊天）
export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  stream: true
  temperature?: number
}

// 流式响应中的一个 chunk（OpenAI SSE 格式），保持宽松：delta.content 允许为 null
export type ChatCompletionChunk = {
  id?: string
  choices: Array<{
    delta: { content?: string | null; role?: string }
    finish_reason?: string | null
  }>
}

// 上传附件（聊天测试页使用）：文件对象 + 预览用的 data URL
export type UploadedAttachment = {
  id: string
  file: File
  dataUrl: string
  mime: string
  size: number
}

// 管理端 API Key 元信息（不含明文密钥，仅用于识别某个用户的 key）
export type ApiKeyMeta = {
  id: number
  name: string
  keyPrefix: string
}

// ========== 查找用户对应的 API Key ==========

// 管理端 /admin/api/keys 返回的完整行结构（见 web/src/views/ApiKeys.vue 的 ApiKeyItem）
interface ApiKeyRow {
  id: number
  name: string
  keyPrefix: string
  expiresAt: number
  disabled: number
}

// 按用户名查找可用的 API Key：
// - 名称完全匹配
// - 未被禁用（disabled === 0）
// - 未过期（expiresAt === 0 表示永不过期）
// 找不到返回 null；接口异常同样返回 null（聊天页对「无 key」统一处理）
export async function findApiKeyForUser(username: string): Promise<ApiKeyMeta | null> {
  try {
    // 管理端 keys 接口（baseURL 已是 /admin/api，实际请求 /admin/api/keys）
    const { data } = (await api.get('/keys')) as { data: { rows: ApiKeyRow[] } }
    const hit = data.rows.find(
      (row) => row.name === username && row.disabled === 0 && (row.expiresAt === 0 || row.expiresAt > Date.now()),
    )
    return hit ? { id: hit.id, name: hit.name, keyPrefix: hit.keyPrefix } : null
  } catch {
    return null
  }
}

// ========== 发起流式聊天 ==========

// 用原生 fetch 直连网关的 /v1/chat/completions（不走 axios，便于拿到 ReadableStream 逐块消费）：
// - Authorization：携带该用户的 API Key（网关将其作为会话身份，不转发给上游）
// - x-session-id：会话标识，网关据此做会话亲和路由（同一会话粘附同一上游）
// - Accept: text/event-stream：声明 SSE 响应
// 非 2xx 抛错（附状态码与响应体摘要）；成功返回响应体流，由调用方逐块 parseSseEvent 解析
export async function createStreamChat(
  req: ChatCompletionRequest,
  apiKey: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'x-session-id': sessionId,
    },
    body: JSON.stringify(req),
    signal,
  })
  if (!response.ok) {
    // 尽量读取错误详情（最多截断 200 字符），失败时退化为状态码文本
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, 200)
    } catch {
      detail = ''
    }
    throw new Error(`chat stream failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
  }
  if (!response.body) {
    throw new Error('chat stream failed: response body is null')
  }
  return response.body
}

// ========== SSE 解析 ==========

// parseSseEvent 是无状态解析器：入参是调用方累积的完整缓冲字符串（每次新数据到达后拼接再传入），
// 按 \n\n 切分成完整事件块解析，末尾未闭合的残片（没有 \n\n 结尾的部分）由调用方自行保留拼接。
// 返回数组：{ data: 载荷 } 表示一个 data 事件；{ done: true } 表示收到 [DONE] 哨兵（流结束）。
// 鲁棒性处理：
//   a) 首个 chunk 可能带 UTF-8 BOM（\uFEFF），直接剥掉；
//   b) 跳过 event: 行与以 : 开头的注释行；
//   c) 兼容 data: payload 与 data:payload 两种写法（冒号后可选一个空格）；
//   d) [DONE] 哨兵大小写敏感（仅全大写视为结束）。
export function parseSseEvent(chunk: string): Array<{ data: string } | { done: true }> {
  // a) 剥离 BOM（stream reader 通常按 chunk 解码，BOM 可能出现在首个字节）
  const text = chunk.startsWith('\uFEFF') ? chunk.slice(1) : chunk

  const events: Array<{ data: string } | { done: true }> = []
  // 按空行切分事件块（SSE 协议：事件以空行分隔）
  for (const block of text.split('\n\n')) {
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      // b) 跳过 event: 行与注释行（: 开头）
      if (rawLine.startsWith('event:') || rawLine.startsWith(':')) continue
      // c) 兼容 data:xxx 与 data: xxx
      if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.slice(5).trim())
      }
    }
    if (dataLines.length === 0) continue

    // 多行 data 按 SSE 规范用换行拼接（实践中少见，保持兼容）
    const payload = dataLines.join('\n')
    // d) [DONE] 哨兵（大小写敏感）：表示流结束
    if (payload === '[DONE]') {
      events.push({ done: true })
    } else {
      events.push({ data: payload })
    }
  }
  return events
}

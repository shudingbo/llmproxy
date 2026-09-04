// 会话消息监控 SSE 客户端：用原生 fetch 直连管理端监控端点，拿 ReadableStream 逐块消费
// （模式与 api/chat.ts 的 createStreamChat 一致：axios 拿不到流式响应体，故走 fetch）
//
// 事件形状（契约在服务端，见 server/src/monitor/index.ts 的 MonitorEvent + admin.ts 的 meta 事件）：
//   { type: 'meta', total, truncated, sessionKey }                    历史回放元信息（首事件）
//   { type: 'message', id, role, content, reasoning, at }             一条完整消息（历史 / 请求侧新写入 / 非流式回答；reasoning 为思考内容，无则空串）
//   { type: 'assistant_delta', id, channel, content }                 流式增量（token 级，不落库；channel: 'think' 思考 / 'content' 正文）
//   { type: 'assistant_done', id, finalId, content, reasoning, at, truncated }
//       流式结束（content / reasoning 为完整文本，供中途订阅者补块）
//
// 调用方负责 abort：关闭抽屉时 abort fetch，服务端在 res 'close' 时自动退订（连接即"停止"）

// meta 事件：历史总数与是否截断（服务端默认回放最新 1000 条）
export type MonitorMetaEvent = { type: 'meta'; total: number; truncated: boolean; sessionKey: string }

// 完整消息事件（reasoning：推理模型的思考内容，无则空串）
export type MonitorMessageEvent = {
  type: 'message'
  id: number
  role: string
  content: string
  reasoning: string
  at: number
}

// 流式增量事件（id 为该轮流式块的临时键；channel 区分思考 / 正文两个通道）
export type MonitorDeltaEvent = { type: 'assistant_delta'; id: string; channel: 'think' | 'content'; content: string }

// 流式结束事件（finalId 为落库行 id，空回答时为 null；truncated 表示流被中断）
export type MonitorDoneEvent = {
  type: 'assistant_done'
  id: string
  finalId: number | null
  content: string
  reasoning: string
  at: number
  truncated: boolean
}

export type MonitorEvent = MonitorMetaEvent | MonitorMessageEvent | MonitorDeltaEvent | MonitorDoneEvent

// 401（管理端会话失效）处理与 api/client.ts 的 axios 拦截器同语义：
// 清除前端登录态并跳转登录页（保留回跳地址）；动态 import 避免循环依赖
async function handleUnauthorized(): Promise<void> {
  try {
    const [{ default: router }, { useAuthStore }] = await Promise.all([
      import('../router'),
      import('../stores/auth'),
    ])
    useAuthStore().clearAuth()
    const current = router.currentRoute.value
    if (current.path !== '/login') {
      await router.push({ path: '/login', query: { redirect: current.fullPath } })
    }
  } catch {
    // router / store 尚未就绪（极端时序）→ 忽略，由调用方按连接失败处理
  }
}

// 发起监控 SSE 连接（同源请求，浏览器自动携带管理端会话 Cookie）：
// - Accept: text/event-stream：声明 SSE 响应
// 非 2xx 抛错（附状态码与响应体摘要）；成功返回响应体流，由调用方逐块 parseSseEvent 解析
export async function fetchSessionMessages(
  sessionKey: string,
  signal?: AbortSignal,
  limit?: number,
): Promise<ReadableStream<Uint8Array>> {
  const qs = limit !== undefined && limit > 0 ? `?limit=${limit}` : ''
  const response = await fetch(`/admin/api/sessions/${encodeURIComponent(sessionKey)}/messages${qs}`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  })
  if (response.status === 401) {
    await handleUnauthorized()
    throw new Error('session monitor failed: HTTP 401 — 未登录或会话已过期')
  }
  if (!response.ok) {
    // 尽量读取错误详情（最多截断 200 字符），失败时退化为状态码文本
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, 200)
    } catch {
      detail = ''
    }
    throw new Error(`session monitor failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
  }
  if (!response.body) {
    throw new Error('session monitor failed: response body is null')
  }
  return response.body
}

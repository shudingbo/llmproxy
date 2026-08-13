// OpenAI 兼容上游的 HTTP 客户端：模型列表 / 聊天补全（非流式与 SSE 流式）
// 只负责把请求发到上游并返回响应（或响应流）；不做重试、不做故障转移（那是 router 的职责）
import { Readable } from 'node:stream'
import axios from 'axios'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type { Upstream } from '../config/schema.js'

// Responses 原生支持探测的独立超时：默认上游超时（30s）对探测过长，单独收紧到 5s
const PROBE_TIMEOUT_MS = 5000

// 上游请求体最小公共形状（chat / responses 共用）：model + stream 为核心，其余字段原样透传
export interface UpstreamStreamRequest {
  model: string
  stream?: boolean
  stream_options?: { include_usage: boolean }
  [key: string]: unknown
}

// OpenAI 兼容的聊天补全请求体（宽松结构，其余字段原样透传，由上游决定是否忽略）
export interface UpstreamChatRequest extends UpstreamStreamRequest {
  messages: Array<{ role: string; content: string; name?: string }>
}

// OpenAI Responses 请求体（宽松结构；用 input 而非 messages，其余字段原样透传）
export interface UpstreamResponsesRequest extends UpstreamStreamRequest {
  input?: string | Array<unknown>
}

// OpenAI 兼容的文本嵌入请求体（宽松结构；embeddings 协议无 stream 概念，
// input 支持字符串 / 字符串数组 / token 数组 / 多模态 content 对象，其余字段原样透传）
export interface UpstreamEmbeddingsRequest {
  model: string
  input: string | Array<string | number[] | { content: string }>
  encoding_format?: 'float' | 'base64'
  dimensions?: number
  user?: string
  [key: string]: unknown
}

// 流式探测关注的最小事件形状（其余字段原样忽略）
interface ResponsesProbeEvent {
  type?: string
  item_id?: string
  item?: { id?: string; type?: string }
}

// OpenAI 兼容的聊天补全响应体（宽松结构，调用方按需取字段）
export interface UpstreamChatResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index?: number
    message?: { role: string; content?: string }
    delta?: { role?: string; content?: string }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  [key: string]: unknown
}

// OpenAI 兼容的文本嵌入响应体（宽松结构；embedding 为 float 数组或 base64 字符串，调用方按需取字段）
export interface UpstreamEmbeddingsResponse {
  object?: string
  data?: Array<{ object?: string; embedding?: Array<number | string>; index?: number }>
  model?: string
  usage?: { prompt_tokens?: number; total_tokens?: number }
  [key: string]: unknown
}

// 重排序请求体（宽松结构；rerank 协议无 stream 概念，query 为查询串、documents 为待排序
// 文档列表——每项既可以是纯文本字符串，也可以是含 content（多模态内容数组）/ text 的对象
// 形状，其余字段原样透传，由上游决定是否忽略）
export interface UpstreamRerankRequest {
  model: string
  query?: string
  documents?: Array<
    | string
    | { content?: Array<Record<string, unknown>>; text?: string; [k: string]: unknown }
  >
  top_n?: number
  [key: string]: unknown
}

// 重排序响应体（宽松结构；results 元素携带 index / relevance_score（或 score）/
// document 等字段，调用方按需取字段）
export interface UpstreamRerankResponse {
  results?: Array<{
    index?: number
    relevance_score?: number
    score?: number
    document?: unknown
    [k: string]: unknown
  }>
  [key: string]: unknown
}

// 流式调用结果：stream 为上游 SSE 响应流，abort() 立即断开底层连接
// connectError 用于判断连接阶段是否成功（HTTP 状态码 / 网络错误）。
// 因为 axios 流式调用是后端 promise 排队发起的，try/catch 抓不到阶段错误，
// 所以这个 promise 让调用方在拿到 stream 之后 await 一下：null=成功，Error=失败
export interface UpstreamStreamResult {
  stream: Readable
  abort: () => void
  /**
   * 连接阶段结果：非 null 表示发生了 5xx/429/网络错误等不可接受的连接错误。
   * 在 stream 返回之前和之后都会 resolve 一次且仅一次（主动 abort 不会视为错误，
   * 只是把流拆掉）。
   */
  connectError: Promise<Error | null>
}

// 上游请求公共选项：signal 中止 + 附加请求头（当前用于会话头 x-session-id 透传）。
// headers 仅作附加：展开在鉴权头之前，绝不允许覆盖配置的 Authorization / Content-Type
export interface UpstreamRequestOptions {
  signal?: AbortSignal
  includeUsage?: boolean
  headers?: Record<string, string>
}

// 构造参数（baseUrl 形如 https://api.openai.com/v1）
export interface OpenAIUpstreamClientOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export class OpenAIUpstreamClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor({ baseUrl, apiKey, timeoutMs }: OpenAIUpstreamClientOptions) {
    // 去掉尾部斜杠，避免拼路径时出现双斜杠
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    // apiKey 仅存于私有字段，任何日志/请求体都不应包含它
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
  }

  /**
   * 通用请求：非流式返回解析后的 JSON 体，流式返回 Readable。
   * signal 直接传给 axios，中止时由 axios 拆除底层 TCP 连接，而非仅仅停止读取。
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; stream?: boolean; timeout?: number; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url: `${this.baseUrl}${path}`,
      // 鉴权头只来自配置，绝不接受调用方传入的 Authorization；
      // 附加头（如 x-session-id）展开在鉴权头之前，保证 Authorization / Content-Type 不可被覆盖
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',        
        ...options.headers,
        // Authorization: `Bearer ${this.apiKey}`,
        // 'Content-Type': 'application/json',

      },
      // 未显式传 timeout 时沿用默认值，probe 等场景可单独覆盖
      timeout: options.timeout ?? this.timeoutMs,
      signal: options.signal,
    }
    console.log('--config headers', config.headers, Object.keys(body as any), body?.stream_options)
    if (body !== undefined) {
      config.data = body
    }
    if (options.stream === true) {
      config.responseType = 'stream'
      const res = await axios.request<unknown, AxiosResponse<Readable>>(config)
      return res.data as unknown as T
    }
    const res = await axios.request<unknown, AxiosResponse<unknown>>(config)
    return res.data as T
  }

  /** 查询上游模型列表：返回 [{ id }] 数组，字段缺失由调用方负责 */
  async listModels(): Promise<Array<{ id: string }>> {
    const body = await this.request<{ data: Array<{ id: string }> }>('GET', '/models')
    return body.data
  }

  /** 非流式聊天补全：req.stream 为 true 时直接报错（应改用 chatCompletionStream） */
  async chatCompletion(
    req: UpstreamChatRequest,
    options: UpstreamRequestOptions = {},
  ): Promise<UpstreamChatResponse> {
    if (req.stream === true) {
      throw new Error('chatCompletion 不接受流式请求，请改用 chatCompletionStream')
    }
    // 拷贝请求体并强制关闭流式，确保走非流分支
    const body = { ...req, stream: false }
    return this.request<UpstreamChatResponse>('POST', '/chat/completions', body, {
      signal: options.signal,
      headers: options.headers,
    })
  }

  /** 文本嵌入：embeddings 协议无 stream，请求体原样透传（模型名改写由路由层负责），不做任何强制改写 */
  async createEmbedding(
    req: UpstreamEmbeddingsRequest,
    options: UpstreamRequestOptions = {},
  ): Promise<UpstreamEmbeddingsResponse> {
    return this.request<UpstreamEmbeddingsResponse>('POST', '/embeddings', req, {
      signal: options.signal,
      headers: options.headers,
    })
  }

  /** 文本重排序：rerank 协议无 stream，请求体原样透传（模型名改写由路由层负责），不做任何强制改写 */
  async rerank(
    req: UpstreamRerankRequest,
    options: UpstreamRequestOptions = {},
  ): Promise<UpstreamRerankResponse> {
    return this.request<UpstreamRerankResponse>('POST', '/rerank', req, {
      signal: options.signal,
      headers: options.headers,
    })
  }

  /** 流式聊天补全：返回 SSE 响应流与 abort 函数（同步返回，请求在后台发起） */
  chatCompletionStream(
    req: UpstreamChatRequest,
    options: UpstreamRequestOptions = {},
  ): UpstreamStreamResult {
    return this.streamRequest('/chat/completions', req, options)
  }

  /** 非流式 Responses 调用：req.stream 为 true 时直接报错（应改用 responsesCompletionStream） */
  async responsesCompletion(
    req: UpstreamResponsesRequest,
    options: UpstreamRequestOptions = {},
  ): Promise<unknown> {
    if (req.stream === true) {
      throw new Error('responsesCompletion 不接受流式请求，请改用 responsesCompletionStream')
    }
    // 拷贝请求体并强制关闭流式，确保走非流分支
    const body = { ...req, stream: false }
    return this.request<unknown>('POST', '/responses', body, {
      signal: options.signal,
      headers: options.headers,
    })
  }

  /** 流式 Responses 调用：返回 SSE 响应流与 abort 函数（同步返回，请求在后台发起） */
  responsesCompletionStream(
    req: UpstreamResponsesRequest,
    options: UpstreamRequestOptions = {},
  ): UpstreamStreamResult {
    return this.streamRequest('/responses', req, options)
  }

  /**
   * 流式请求公共实现：chat / responses 共用。
   * 返回 SSE 响应流与 abort 函数；连接阶段结果经 connectError promise 上报
   * （axios 流式请求在后台发起，try/catch 抓不到连接失败）。
   */
  private streamRequest(
    path: string,
    req: UpstreamStreamRequest,
    options: UpstreamRequestOptions = {},
  ): UpstreamStreamResult {
    // 拷贝请求体并强制开启流式
    const body: UpstreamStreamRequest = { ...req, stream: true }
    // 仅当请求本身是流式且调用方要求统计用量时注入 stream_options
    // （上游会在流末尾补发 usage 块，供 T15 的读取器消费）
    if (req.stream === true && options.includeUsage === true) {
      body.stream_options = { include_usage: true }
    }

    // 内部取消控制器：abort() 与外部 signal 都汇聚到这里，保证只拆一次线
    const controller = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort()
      } else {
        // 外部 signal 触发时同步转发给内部控制器
        options.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    // 包装流：axios 响应流就绪后把数据桥接给调用方
    let axiosSource: Readable | null = null
    let ended = false
    const stream = new Readable({
      read() {
        // 消费者就绪后恢复底层流流动（处理背压）
        if (axiosSource) {
          axiosSource.resume()
        }
      },
    })

    // 连接阶段错误 promise：null=连接成功，Error=连接失败（5xx/429/网络错误等）。
    // 必须 resolve 一次且仅一次；主动 abort 不算连接错误，仅静默拆线
    let resolveConnectError: (err: Error | null) => void = () => {}
    const connectErrorPromise = new Promise<Error | null>((resolve) => {
      resolveConnectError = resolve
    })

    // 拆线：销毁底层响应流并结束包装流（幂等，已结束时为 no-op）
    const teardown = () => {
      if (ended) {
        return
      }
      ended = true
      if (axiosSource) {
        axiosSource.destroy()
      }
      if (!stream.destroyed) {
        stream.destroy()
      }
    }
    // 中止信号触发时立即拆线，防止继续消费上游数据
    controller.signal.addEventListener('abort', teardown, { once: true })

    // 后台发起请求，响应流就绪后桥接数据
    this.request<Readable>('POST', path, body, {
      signal: controller.signal,
      stream: true,
      headers: options.headers,
    })
      .then((source) => {
        // 收到 2xx 响应：连接成功，通知调用方
        resolveConnectError(null)
        axiosSource = source
        source.on('data', (chunk: Buffer) => {
          if (ended) {
            return
          }
          // push 返回 false 说明消费者跟不上，暂停底层流
          if (!stream.push(chunk)) {
            source.pause()
          }
        })
        source.on('end', () => {
          ended = true
          if (!stream.destroyed) {
            stream.push(null)
          }
        })
        source.on('error', (err: Error) => {
          ended = true
          if (!stream.destroyed) {
            stream.destroy(err)
          }
        })
      })
      .catch((err: unknown) => {
        // 主动中止导致的拒绝不当作连接错误上报（让调用方走主动终止路径）
        if (controller.signal.aborted) {
          resolveConnectError(null)
          teardown()
          return
        }
        // 响应阶段（非 2xx / 网络错误）异常：通知调用方后可回退
        const wrapped = err instanceof Error ? err : new Error(String(err))
        resolveConnectError(wrapped)
        if (!stream.destroyed) {
          stream.destroy(wrapped)
        }
      })

    return {
      stream,
      abort: () => {
        // 先中止 axios（拆除 TCP），再销毁底层响应流与包装流
        controller.abort()
        teardown()
      },
      connectError: connectErrorPromise,
    }
  }

  /**
   * 探测上游是否原生支持 Responses API（POST /responses）。
   * 返回 boolean 表示确定性结论；网络错误 / 超时 / 5xx / 429 等探测异常则抛错，
   * 探测异常向上抛，由调用方按失败处理。
   * @param strict 严格语义（缺省 false 保持 /test 端点的「端点存在」旧语义）：
   *   strict=true 时 400 / 422 视为不支持（返回 false），供管理端检测第一步使用——
   *   非流式请求只要不是 2xx + object:response 即判定失败，避免 400 但流式完整的
   *   不对称场景误判 native。
   */
  async probeResponsesSupport(model?: string, strict = false): Promise<boolean> {
    const body = {
      model: model ?? 'gpt-4o-mini',
      input: 'ping',
      max_output_tokens: 1,
      stream: false,
    }
    try {
      // 2xx：端点存在，仅当响应体 object === 'response' 才算原生支持（形状不符 → false）
      const data = await this.request<{ object?: string }>('POST', '/responses', body, {
        timeout: PROBE_TIMEOUT_MS,
      })
      return data?.object === 'response'
    } catch (err) {
      // axios 非 2xx 抛 AxiosError（含 err.response?.status）；网络错误 / 超时没有 status
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      if (status !== undefined) {
        // 严格语义：任何非 2xx（含 400 / 422 / 404 / 405 / 401 / 403）都视为不支持
        if (strict) {
          return false
        }
        // 400 / 422 → 端点存在，仅参数或模型不被接受（确定性 true，/test 端点语义）
        if (status === 400 || status === 422) {
          return true
        }
        // 404 / 405 → 端点不存在；401 / 403 → 鉴权配置错误（确定性 false）
        if (status === 404 || status === 405 || status === 401 || status === 403) {
          return false
        }
      }
      // 网络错误 / 超时 / 5xx / 429 / 其余非 2xx → 探测异常，向上抛，由调用方按失败处理
      throw err
    }
  }

  /**
   * 探测上游流式 Responses 事件完整性（管理端「检测 responsesApi」第二步）。
   * 流式消费整个 SSE 流，验证：
   *  - 收到 response.completed（type=response.completed）
   *  - 出现过 message 输出事件（output_item.added 且 item.type === 'message'、
   *    content_part.added、output_text.delta / output_text.done 任一）——探测请求
   *    加大输出预算后仍只有 reasoning 的上游（推理模型）判不支持（convert）
   *  - 每个 message item 的 output_item.added + content_part.added 事件先于其
   *    output_text.delta / output_text.done 出现（顺序完整）
   * 全部满足 → true；任何异常（网络 / 超时 / 5xx / 流解析失败 / 缺少 completed /
   * 无 message 事件 / 事件顺序违规）→ 返回 false（不抛错，管理端检测用：失败即按
   * convert 处理）。
   */
  async probeResponsesStream(model?: string): Promise<boolean> {
    const body = {
      model: model ?? 'gpt-4o-mini',
      input: 'ping',
      // 128 而非 1：给 message 输出留出 token 预算——推理模型首个 token 总在思考，
      // 预算过小则永远等不到 message 事件，导致流式验证形同虚设
      max_output_tokens: 128,
      stream: true,
    }
    let stream: Readable
    try {
      // timeout 只覆盖连接阶段（响应头未及时返回即中止）；流已建立后由 watchdog 兜底
      stream = await this.request<Readable>('POST', '/responses', body, {
        timeout: PROBE_TIMEOUT_MS,
        stream: true,
      })
    } catch {
      // 网络错误 / 超时 / 5xx / 非 2xx → 探测失败
      return false
    }

    // 独立 5s 兜底：上游迟迟不结束流时强制拆线，避免探测挂死
    const watchdog = setTimeout(() => stream.destroy(), PROBE_TIMEOUT_MS)
    watchdog.unref()
    try {
      return await this.consumeResponsesProbe(stream)
    } finally {
      clearTimeout(watchdog)
    }
  }

  /** 消费探测响应流：解析 SSE data: 行并返回事件完整性判定 */
  private async consumeResponsesProbe(stream: Readable): Promise<boolean> {
    // message item 状态：output_item.added 与 content_part.added 是否已出现
    const itemState = new Map<string, { added: boolean; partAdded: boolean }>()
    // 跨行共享状态：流中是否出现过 message 输出事件（仅 reasoning 的推理模型为 false）
    const state = { sawMessage: false }
    // 跨 chunk 累积未换行的字节，保证单条 SSE 行跨多个 chunk 也能完整解析
    let buffer = ''
    let completed = false
    let violated = false
    try {
      for await (const chunk of stream) {
        buffer += chunk.toString()
        // 按 \n 切出完整行处理；残留的行留在 buffer 等待下一个 chunk
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          const verdict = this.consumeResponsesProbeLine(line, itemState, state)
          if (verdict === 'completed') {
            completed = true
          } else if (verdict === 'violated') {
            violated = true
          }
          nl = buffer.indexOf('\n')
        }
      }
    } catch {
      // 流中途出错（连接被拆 / 传输中断）→ 探测失败
      return false
    }
    // 需同时满足：收到 response.completed、无事件顺序违规、出现过 message 输出事件
    return completed && !violated && state.sawMessage
  }

  /** 解析一条 SSE data: 行：更新 item 状态或返回判定（completed / violated / null） */
  private consumeResponsesProbeLine(
    line: string,
    itemState: Map<string, { added: boolean; partAdded: boolean }>,
    state: { sawMessage: boolean },
  ): 'completed' | 'violated' | null {
    // 只处理 data: 行，其余（event: / 空行 / 注释）一律忽略
    if (!line.startsWith('data: ')) {
      return null
    }
    const payload = line.slice('data: '.length).trim()
    // 流结束标记 / 空负载不参与判定
    if (payload === '' || payload === '[DONE]') {
      return null
    }
    let evt: ResponsesProbeEvent
    try {
      evt = JSON.parse(payload) as ResponsesProbeEvent
    } catch {
      // 非 JSON 的 data 行 → 流解析失败
      return 'violated'
    }
    switch (evt.type) {
      case 'response.completed':
        return 'completed'
      case 'response.output_item.added': {
        // 只跟踪 message item；reasoning / function_call 不产生 output_text，不影响判定
        const itemId = evt.item?.id
        if (evt.item?.type === 'message' && itemId !== undefined) {
          state.sawMessage = true
          const itemStateEntry = itemState.get(itemId) ?? { added: false, partAdded: false }
          itemStateEntry.added = true
          itemState.set(itemId, itemStateEntry)
        }
        return null
      }
      case 'response.content_part.added': {
        // content_part 只属于 message 输出（reasoning 走 reasoning_text.delta 等独立事件）
        const itemId = evt.item_id
        if (itemId !== undefined) {
          state.sawMessage = true
          const itemStateEntry = itemState.get(itemId) ?? { added: false, partAdded: false }
          itemStateEntry.partAdded = true
          itemState.set(itemId, itemStateEntry)
        }
        return null
      }
      case 'response.output_text.delta':
      case 'response.output_text.done': {
        // delta / done 本身即 message 输出事件；但必须晚于该 item 的 output_item.added
        // + content_part.added，否则为事件顺序违规（llama.cpp 偶发漏发 output_item.added 即此场景）
        state.sawMessage = true
        const itemStateEntry = evt.item_id !== undefined ? itemState.get(evt.item_id) : undefined
        if (itemStateEntry === undefined || !itemStateEntry.added || !itemStateEntry.partAdded) {
          return 'violated'
        }
        return null
      }
      default:
        return null
    }
  }
}

// 便捷工厂：从配置中的 Upstream 条目直接构建客户端
export function openaiClient(upstream: Upstream): OpenAIUpstreamClient {
  return new OpenAIUpstreamClient({
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    timeoutMs: upstream.timeoutMs,
  })
}

// OpenAI 兼容上游的 HTTP 客户端：模型列表 / 聊天补全（非流式与 SSE 流式）
// 只负责把请求发到上游并返回响应（或响应流）；不做重试、不做故障转移（那是 router 的职责）
import { Readable } from 'node:stream'
import axios from 'axios'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type { Upstream } from '../config/schema.js'

// OpenAI 兼容的聊天补全请求体（宽松结构，其余字段原样透传，由上游决定是否忽略）
export interface UpstreamChatRequest {
  model: string
  messages: Array<{ role: string; content: string; name?: string }>
  stream?: boolean
  stream_options?: { include_usage: boolean }
  [key: string]: unknown
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
    options: { signal?: AbortSignal; stream?: boolean } = {},
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url: `${this.baseUrl}${path}`,
      // 鉴权头只来自配置，绝不接受调用方传入的 Authorization
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: this.timeoutMs,
      signal: options.signal,
    }
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
    options: { signal?: AbortSignal; includeUsage?: boolean } = {},
  ): Promise<UpstreamChatResponse> {
    if (req.stream === true) {
      throw new Error('chatCompletion 不接受流式请求，请改用 chatCompletionStream')
    }
    // 拷贝请求体并强制关闭流式，确保走非流分支
    const body = { ...req, stream: false }
    return this.request<UpstreamChatResponse>('POST', '/chat/completions', body, {
      signal: options.signal,
    })
  }

  /** 流式聊天补全：返回 SSE 响应流与 abort 函数（同步返回，请求在后台发起） */
  chatCompletionStream(
    req: UpstreamChatRequest,
    options: { signal?: AbortSignal; includeUsage?: boolean } = {},
  ): UpstreamStreamResult {
    // 拷贝请求体并强制开启流式
    const body: UpstreamChatRequest = { ...req, stream: true }
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
    this.request<Readable>('POST', '/chat/completions', body, {
      signal: controller.signal,
      stream: true,
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
}

// 便捷工厂：从配置中的 Upstream 条目直接构建客户端
export function openaiClient(upstream: Upstream): OpenAIUpstreamClient {
  return new OpenAIUpstreamClient({
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    timeoutMs: upstream.timeoutMs,
  })
}

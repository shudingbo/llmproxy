// 上游模型上下文探测：并行请求 llama.cpp / LM Studio 的模型列表端点，取首个能解析出上下文长度的结果
// 参考实现：/mnt/mywork/work/app-git/ai-gateway/lib/context/resolver.ts
// 本模块为纯函数、无缓存、无副作用（供管理端探测 API 调用，见 T3）
import axios from 'axios'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import { getLogger } from '../logger/index.js'

export interface ProbeContextOptions {
  apiKey?: string
  /** 请求超时（毫秒），缺省 5000 */
  timeoutMs?: number
  /** 可选：指定模型名时按 id 过滤（llama.cpp 与 LM Studio 均生效） */
  model?: string
}

// 缺省请求超时（毫秒），与参考实现一致
const DEFAULT_TIMEOUT_MS = 5000

// llama.cpp /v1/models 响应结构（宽松：只取需要的字段，其余忽略）
interface LlamaCppModelsResponse {
  data?: Array<{ id?: string; meta?: { n_ctx?: number | string | null } }>
}

// LM Studio /api/v1/models 响应结构（宽松）
interface LmStudioModelsResponse {
  models?: Array<{
    id?: string
    loaded_instances?: Array<{ id?: string; config?: { context_length?: number | string | null } }>
  }>
}

/**
 * 探测上游模型最大上下文长度。
 * 并行请求两个端点（Promise.allSettled），取首个成功解析出正整数值的结果：
 * - llama.cpp: GET {origin}/v1/models → data[].meta.n_ctx
 * - LM Studio: GET {origin}/api/v1/models → models[].loaded_instances[].config.context_length
 * 两端点均失败 / 无值 → 返回 null（不抛错，失败记 warn 日志）。
 */
export async function probeMaxContext(baseUrl: string, options: ProbeContextOptions = {}): Promise<number | null> {
  const origin = getOrigin(baseUrl)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const model = options.model ?? ''
  // apiKey 非空才带鉴权头；为空不带（避免无意义地暴露 Bearer 空串）
  const headers: Record<string, string> = {}
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`
  }

  // 并行请求两个端点，取首个成功
  const results = await Promise.allSettled([
    tryLlamaCpp(origin, model, timeoutMs, headers),
    tryLmStudio(origin, model, timeoutMs, headers),
  ])

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      return result.value
    }
  }

  // 两端点都失败：逐条记 warn（请求异常 / 非 2xx 由 axios 抛错落入 rejected 分支），函数本身不抛错
  const endpointNames = ['llama.cpp', 'LM Studio']
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      getLogger().warn({ err: result.reason }, `探测 ${endpointNames[index]} 上游上下文失败`)
    }
  })
  return null
}

/** 从 baseUrl 提取 origin（剥掉路径）；URL 非法时原样返回 baseUrl 字符串（后续请求必然失败，最终返回 null） */
function getOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * 尝试 llama.cpp 的 /v1/models 端点：data[].meta.n_ctx，Number 后 >0 且非 NaN 即返回。
 * model 为空时不按 id 过滤（取首个有值模型）。
 * axios 默认对非 2xx 抛错（落入 Promise.allSettled 的 rejected 分支，视为该端点失败）。
 */
async function tryLlamaCpp(
  origin: string,
  model: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<number | null> {
  const url = `${origin.replace(/\/+$/, '')}/v1/models`
  const config: AxiosRequestConfig = {
    method: 'GET',
    url,
    headers,
    timeout: timeoutMs,
  }
  const res = await axios.request<unknown, AxiosResponse<unknown>>(config)
  const body = res.data as LlamaCppModelsResponse | undefined
  const models = body?.data
  if (Array.isArray(models) && models.length > 0) {
    for (const m of models) {
      if (model && m?.id !== model) {
        continue
      }
      const nCtx = Number(m?.meta?.n_ctx)
      if (!Number.isNaN(nCtx) && nCtx > 0) {
        return nCtx
      }
    }
  }
  return null
}

/**
 * 尝试 LM Studio 的 /api/v1/models 端点：models[].loaded_instances[].config.context_length。
 * 修复点（相对参考实现）：model 为空时不按 instance.id 过滤——参考实现里
 * `if (itIns?.id !== model) continue;` 在 model 为空时恒 continue 导致必失败。
 * axios 默认对非 2xx 抛错（视为该端点失败）。
 */
async function tryLmStudio(
  origin: string,
  model: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<number | null> {
  const url = `${origin.replace(/\/+$/, '')}/api/v1/models`
  const config: AxiosRequestConfig = {
    method: 'GET',
    url,
    headers,
    timeout: timeoutMs,
  }
  const res = await axios.request<unknown, AxiosResponse<unknown>>(config)
  const body = res.data as LmStudioModelsResponse | undefined
  const models = body?.models
  if (Array.isArray(models) && models.length > 0) {
    for (const m of models) {
      const instances = m?.loaded_instances
      if (!Array.isArray(instances) || instances.length === 0) {
        continue
      }
      for (const instance of instances) {
        if (model && instance?.id !== model) {
          continue
        }
        const contextLength = Number(instance?.config?.context_length)
        if (!Number.isNaN(contextLength) && contextLength > 0) {
          return contextLength
        }
      }
    }
  }
  return null
}

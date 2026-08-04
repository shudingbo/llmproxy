// OpenAI 模型列表 → Ollama /api/tags 响应 转换器
// 只做纯数据映射：把已抓取到的 OpenAI 模型列表包装成 Ollama 模型列表结构
// 不探测上游、不补真实元数据——尺寸/时间等均为占位 stub，由后续 Todo 完善
import type { OllamaModel, OllamaTagsResponse } from './types.js'

// OpenAI /models 返回的单个模型条目（宽松结构，只取 id）
export interface OpenAIModelEntry {
  id: string
  object?: string
}

// OpenAI /models 响应体（本转换器只消费 data 数组）
export interface OpenAIModelsResponse {
  data: OpenAIModelEntry[]
}

// 每个 OpenAI 模型映射为一条 Ollama 模型，元数据为固定占位值
const PLACEHOLDER_MODIFIED_AT = '2026-01-01T00:00:00Z'

/**
 * 把 OpenAI 模型列表转换为 Ollama /api/tags 响应结构。
 * name/model 复用 OpenAI 的 id；其余字段为占位 stub（不发起任何上游请求）。
 * metaById：别名 → 聚合上下文映射；条目命中时附加 meta 字段，未命中/不传时输出与原来一致
 */
export function convertModelsList(
  openaiResp: OpenAIModelsResponse,
  metaById?: Readonly<Record<string, { n_ctx: number }>>,
): OllamaTagsResponse {
  const models: OllamaModel[] = openaiResp.data.map((entry) => {
    const model: OllamaModel = {
      name: entry.id,
      model: entry.id,
      modified_at: PLACEHOLDER_MODIFIED_AT,
      size: 0,
      details: {
        format: 'openai',
        family: 'openai',
      },
    }
    const meta = metaById?.[entry.id]
    if (meta !== undefined) {
      model.meta = meta
    }
    return model
  })
  return { models }
}

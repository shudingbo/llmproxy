// 转换器共享类型：Ollama 模型列表相关结构
// 对齐 Ollama /api/tags 响应契约（https://docs.ollama.com/api/tags）
// 只声明本仓库转换器用到的字段，其余按宽松处理

// Ollama /api/tags 中的单个模型条目
export interface OllamaModel {
  name: string
  model: string
  modified_at: string
  size: number
  // 聚合后的上下文大小（下游别名分组内候选 max_context_length 的最小值）
  meta?: { n_ctx: number }
  // digest 由真实 Ollama 返回；stub 阶段可缺省
  digest?: string
  details: {
    // 模型格式（gguf / openai 等）
    format: string
    // 模型家族（llama / openai 等）
    family: string
    // 家族变体列表：openai 占位为空数组
    families?: string[]
    // 参数量描述（占位为空字符串）
    parameter_size?: string
    // 量化等级（占位为空字符串）
    quantization_level?: string
  }
}

// Ollama /api/tags 响应体
export interface OllamaTagsResponse {
  models: OllamaModel[]
}

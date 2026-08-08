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
  // 聚合后的能力集合（别名分组内候选 capabilities 的并集）；未配置时缺省
  capabilities?: string[]
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

// Ollama POST /api/show 响应体（模型详情，数据来自下游别名配置而非上游探测）
export interface OllamaShowResponse {
  // 许可证 / 模型文件 / 采样参数 / 提示模板：占位空串（本网关不持有真实模型文件）
  license: string
  modelfile: string
  parameters: string
  template: string
  // 模型详情：openai 占位（format / family 固定，families 空数组，参数/量化空串）
  details: {
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
  // 模型信息：general.architecture 固定 openai；
  // 仅当别名能聚合出有限正整数 max_context_length 时附加 openai.context_length
  model_info: {
    'general.architecture': string
    'openai.context_length'?: number
  }
  // 能力集合：别名分组内候选 capabilities 的并集；无配置则为空数组
  capabilities: string[]
  // 修改时间：当前时刻 ISO 8601（本网关无真实模型文件，按查询时刻生成）
  modified_at: string
}

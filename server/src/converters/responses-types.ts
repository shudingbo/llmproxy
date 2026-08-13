// OpenAI Responses API 类型定义（网关边界使用的子集）
// 只声明本仓库转换器用到的字段，其余按宽松结构处理（与 upstream/openai.ts 风格一致）
// 对齐 OpenAI Responses 契约：https://platform.openai.com/docs/api-reference/responses

// ---------- 请求（POST /v1/responses） ----------

// Responses 内容片段（多模态）：input_text / output_text / text 片段取 text 字段，其余忽略
export interface ResponsesContentPart {
  type?: string
  text?: string
  [key: string]: unknown
}

// Responses 输入项：消息（{role, content} 或 {type:'message', role, content}）
// 或其它类型项（function_call / function_call_output / reasoning 等，网关忽略）
export type ResponsesInputItem =
  | { role: string; content: string | ResponsesContentPart[] }
  | { type?: string; [key: string]: unknown }

// POST /v1/responses 请求体（宽松结构，只声明本转换器关心的字段）
export interface ResponsesRequest {
  model: string
  // 字符串或消息数组（缺省视为空输入）
  input?: string | ResponsesInputItem[]
  // 可选：作为 system 提示，置于 input 之前
  instructions?: string
  stream?: boolean
  // max_output_tokens 透传映射为上游 max_tokens
  max_output_tokens?: number
  temperature?: number
  // 可选，透传（或忽略）
  include?: string[]
  // 工具列表（扁平 function 结构），转换时保持顺序并包装为 chat 嵌套形状
  tools?: unknown[]
  // 工具选择：字符串（auto/none/required）或 { type: 'function', name } 对象
  tool_choice?: unknown
  [key: string]: unknown
}

// ---------- 响应（非流式） ----------

// 输出文本片段（annotations 固定为空数组，网关不产出注释）
export interface ResponsesOutputTextPart {
  type: 'output_text'
  text: string
  annotations: unknown[]
}

// 输出消息项
export interface ResponsesOutputMessage {
  type: 'message'
  id: string
  role: string
  status: string
  content: ResponsesOutputTextPart[]
}

// token 用量（chat usage 映射而来，字段名对齐 Responses 契约）
export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

// 非流式响应体
export interface ResponsesResponse {
  id: string
  object: 'response'
  created_at: number
  status: string
  model: string
  output: ResponsesOutputMessage[]
  usage?: ResponsesUsage
  [key: string]: unknown
}

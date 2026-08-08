// server 暴露的全部下游端点清单：单一真相源
// 启动日志（server/index.ts）与 /admin/api/health（admin.ts）共用此清单，
// 避免硬编码重复。增删下游路由时仅需修改本文件，前端 Dashboard 自动跟随。
//
// - type     下游协议分类：openai（OpenAI 兼容）/ ollama（Ollama 兼容）/ admin（管理端）
// - method   HTTP 方法，单大写单词；同一 path 多方法时各占一条
// - path     暴露的 URL 路径前缀（以 / 开头）
// - summary  一句话中文说明，展示用
export interface DownstreamEndpoint {
  type: 'openai' | 'ollama' | 'admin'
  method: string
  path: string
  summary: string
}

// 静态清单：与 server/src/server/openai.ts / ollama.ts / admin.ts 的实际注册保持一致
export const DOWNSTREAM_ENDPOINTS: ReadonlyArray<DownstreamEndpoint> = [
  // OpenAI 兼容下游
  { type: 'openai', method: 'GET', path: '/v1/models', summary: '返回下游模型别名列表' },
  { type: 'openai', method: 'POST', path: '/v1/chat/completions', summary: '聊天补全，支持非流式与流式（SSE）' },
  { type: 'openai', method: 'POST', path: '/v1/responses', summary: 'Responses API，支持非流式与流式（SSE）' },
  { type: 'openai', method: 'POST', path: '/v1/embeddings', summary: '文本嵌入（embeddings）' },
  { type: 'openai', method: 'POST', path: '/rerank', summary: '按相关性对文档重排序（rerank，/v1/rerank 的同义路径）' },
  { type: 'openai', method: 'POST', path: '/v1/rerank', summary: '按相关性对文档重排序（rerank）' },
  // Ollama 兼容下游
  { type: 'ollama', method: 'GET', path: '/api/tags', summary: '聚合后的 Ollama 模型列表' },
  { type: 'ollama', method: 'POST', path: '/api/chat', summary: 'Ollama 聊天接口（NDJSON 流 / JSON 非流）' },
  { type: 'ollama', method: 'POST', path: '/api/show', summary: '查询模型详情（capabilities、context_length 等）' },
  { type: 'ollama', method: 'POST', path: '/api/version', summary: 'Ollama 版本查询' },
  // 管理端
  { type: 'admin', method: 'GET', path: '/admin/api/health', summary: '健康检查（upstreams / downstreams）' },
  { type: 'admin', method: 'GET', path: '/admin/api/upstreams', summary: '上游列表（apiKey 已掩码）' },
  { type: 'admin', method: 'POST', path: '/admin/api/upstreams', summary: '新增上游' },
  { type: 'admin', method: 'PUT', path: '/admin/api/upstreams/:id', summary: '部分更新上游' },
  { type: 'admin', method: 'DELETE', path: '/admin/api/upstreams/:id', summary: '删除上游（级联清理下游映射）' },
  { type: 'admin', method: 'POST', path: '/admin/api/upstreams/:id/test', summary: '上游连通性测试' },
  { type: 'admin', method: 'GET', path: '/admin/api/downstream-models', summary: '下游模型别名映射' },
  { type: 'admin', method: 'PUT', path: '/admin/api/downstream-models', summary: '整体替换下游模型映射' },
  { type: 'admin', method: 'GET', path: '/admin/api/logs', summary: '按日期 / 级别 / 关键词查询日志' },
  { type: 'admin', method: 'GET', path: '/admin/api/stats', summary: '请求统计（进程启动起算）' },
  { type: 'admin', method: 'GET', path: '/admin/api/config', summary: '当前生效配置（apiKey 已掩码）' },
  { type: 'admin', method: 'GET', path: '/admin/api/config/reload-error', summary: '最近一次外部重载错误' },
]

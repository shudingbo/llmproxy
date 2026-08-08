// Ollama 兼容的模型详情端点（POST /api/show）：
// 数据来源是下游别名配置（downstreamModels 候选的 capabilities / max_context_length 聚合），
// 不代理到任何上游；缺 model 参数返回 400，未知别名返回 404
import type { Express, Request, Response } from 'express'
import type { ConfigStore } from '../config/store.js'
import type { OllamaShowResponse } from '../converters/types.js'
import { buildAliasMetaMap } from './model-meta.js'

/**
 * 注册 Ollama 兼容的模型详情路由：
 * - 200：返回由别名配置聚合的模型详情（capabilities 并集 + 有限正整数 n_ctx）
 * - 400 { error: 'invalid_request', field: 'model' }：body.model 缺失或非字符串
 * - 404 { error: 'model_not_found' }：别名不在 downstreamModels 中
 */
export function registerOllamaShowRoute(app: Express, deps: { store: ConfigStore }): void {
  app.post('/api/show', (req: Request, res: Response) => {
    // express.json 对无请求体时 req.body 为 undefined，先归一化为空对象
    const body = (req.body ?? {}) as Record<string, unknown>
    const model = typeof body.model === 'string' ? body.model : ''
    // 模型参数缺失 / 非字符串 → 400（Ollama 契约：invalid_request + 出错字段名）
    if (model === '') {
      res.status(400).json({ error: 'invalid_request', field: 'model' })
      return
    }
    const config = deps.store.get()
    // 别名不在 downstreamModels → 404（标准「别名 → 候选」契约，不代理上游）
    if (!Object.prototype.hasOwnProperty.call(config.downstreamModels, model)) {
      res.status(404).json({ error: 'model_not_found' })
      return
    }
    // 聚合元数据：n_ctx 仅在别名能聚合出有限正整数时存在；capabilities 为候选并集（无配置为空数组）
    const meta = buildAliasMetaMap(config)[model]
    const modelInfo: OllamaShowResponse['model_info'] = { 'general.architecture': 'openai' }
    if (meta?.n_ctx !== undefined) {
      modelInfo['openai.context_length'] = meta.n_ctx
    }
    res.status(200).json({
      license: '',
      modelfile: '',
      parameters: '',
      template: '',
      details: {
        format: 'openai',
        family: 'openai',
        families: [],
        parameter_size: '',
        quantization_level: '',
      },
      model_info: modelInfo,
      capabilities: meta?.capabilities ?? [],
      modified_at: new Date().toISOString(),
    } satisfies OllamaShowResponse)
  })
}

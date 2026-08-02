// 路由相关错误类型
// 所有路由错误都从这里导出，上层（T11/T12）按 instanceof 区分处理

/**
 * 下游模型别名未在配置的 downstreamModels 中找到时抛出。
 * 携带原始别名，便于日志与错误响应定位。
 */
export class ModelNotFoundError extends Error {
  constructor(model: string) {
    super(`模型 "${model}" 未在配置的下游模型列表中找到`)
    this.name = 'ModelNotFoundError'
  }
}

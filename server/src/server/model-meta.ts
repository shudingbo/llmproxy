// 下游模型列表的上下文聚合：为每个下游别名（聚合分组）计算候选 max_context_length 的最小值
// 仅统计有限正整数（typeof number && Number.isFinite && > 0），null/未配置/非有限值一律忽略；
// 某别名没有任何可用值时该别名不带 meta（由调用方按 undefined 处理）
import type { Config } from '../config/schema.js'

/**
 * 解析单个别名的聚合上下文：
 * 遍历候选，收集其 max_context_length（仅统计有限正整数）；
 * 一个值都没有 → undefined；否则返回 { n_ctx: 最小值 }（与路由的「按最短上下文兜底」语义一致）
 */
export function resolveAliasNctx(config: Config, alias: string): { n_ctx: number } | undefined {
  const values: number[] = []
  for (const candidate of config.downstreamModels[alias]) {
    const value = candidate.max_context_length
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      values.push(value)
    }
  }
  if (values.length === 0) {
    return undefined
  }
  return { n_ctx: Math.min(...values) }
}

/**
 * 为每个下游别名构建 meta 映射（别名 → { n_ctx }）：
 * 仅写入能聚合出有效值的别名，其余别名不在映射中（调用方据此判断是否附加 meta 字段）
 */
export function buildAliasMetaMap(config: Config): Record<string, { n_ctx: number }> {
  const metaMap: Record<string, { n_ctx: number }> = {}
  for (const alias of Object.keys(config.downstreamModels)) {
    const meta = resolveAliasNctx(config, alias)
    if (meta !== undefined) {
      metaMap[alias] = meta
    }
  }
  return metaMap
}

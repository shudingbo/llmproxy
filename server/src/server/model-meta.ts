// 下游模型列表的上下文聚合：为每个下游别名（聚合分组）计算候选 max_context_length 的最小值
// 与 capabilities 的并集；仅统计有限正整数（typeof number && Number.isFinite && > 0），
// null/未配置/非有限值一律忽略；某别名没有任何可用值时该别名不带 meta（由调用方按 undefined 处理）
import type { Config } from '../config/schema.js'

// 别名聚合结果：n_ctx（最短上下文兜底）与 capabilities（能力并集）均可选
export interface AliasMeta {
  n_ctx?: number
  capabilities?: string[]
}

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
 * 解析单个别名的聚合能力集合：
 * 遍历候选，收集其 capabilities 字符串数组（空数组/未配置一律忽略），
 * 跨候选按首次出现顺序去重取并集；没有任何候选配置能力 → undefined
 */
export function resolveAliasCapabilities(config: Config, alias: string): string[] | undefined {
  const seen = new Set<string>()
  for (const candidate of config.downstreamModels[alias]) {
    const capabilities = candidate.capabilities
    if (Array.isArray(capabilities) && capabilities.length > 0) {
      for (const capability of capabilities) {
        seen.add(capability)
      }
    }
  }
  if (seen.size === 0) {
    return undefined
  }
  // Set 保持插入序，即「首次出现顺序」的并集结果
  return [...seen]
}

/**
 * 为每个下游别名构建 meta 映射（别名 → { n_ctx?, capabilities? }）：
 * 仅写入能聚合出有效值的别名（有 n_ctx 或 capabilities 任一），
 * 其余别名不在映射中（调用方据此判断是否附加 meta / capabilities 字段）
 */
export function buildAliasMetaMap(config: Config): Record<string, AliasMeta> {
  const metaMap: Record<string, AliasMeta> = {}
  for (const alias of Object.keys(config.downstreamModels)) {
    const meta: AliasMeta = {}
    const nctx = resolveAliasNctx(config, alias)
    if (nctx !== undefined) {
      meta.n_ctx = nctx.n_ctx
    }
    const capabilities = resolveAliasCapabilities(config, alias)
    if (capabilities !== undefined) {
      meta.capabilities = capabilities
    }
    if (meta.n_ctx !== undefined || meta.capabilities !== undefined) {
      metaMap[alias] = meta
    }
  }
  return metaMap
}

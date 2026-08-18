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
 * 别名在「用户视角」下是否对外暴露：
 * - 别名不在 downstreamModels 中 → false（由调用方按 404 处理）
 * - 别名被总开关关闭（group.disabled === true）→ false
 * - 别名未关闭，但所有候选引用的上游全部 disabled → false
 *   理由：用户看到列表就会以为可调用，调一下却返回 no_upstream，体验割裂。
 *   「所有上游都关」的别名与「被总开关关闭」在列表中应一视同仁地对用户不可见。
 * - 否则 → true
 *
 * 与 Router.resolve() 的语义对齐：列表里看不到的别名，调用时也应 model_not_found。
 */
export function isAliasExposed(config: Config, alias: string): boolean {
  const group = config.downstreamModels[alias]
  if (!group) return false
  if (group.disabled === true) return false
  // 别名未关闭：再判断「是否有候选引用的上游仍是活跃的」
  for (const candidate of group.candidates) {
    const upstream = config.upstreams.find((u) => u.id === candidate.upstreamId)
    if (upstream && upstream.disabled !== true) {
      return true
    }
  }
  return false
}

/**
 * 当前对外暴露的下游别名列表（按配置中插入顺序输出）：
 * 仅在总开关 off 时剔除；具体见 isAliasExposed
 */
export function listExposedAliases(config: Config): string[] {
  return Object.keys(config.downstreamModels).filter((alias) => isAliasExposed(config, alias))
}

/**
 * 解析单个别名的聚合上下文：
 * 别名关闭（总开关 off）或未注册 → undefined；
 * 否则遍历候选，收集其 max_context_length（仅统计有限正整数）；
 * 一个值都没有 → undefined；否则返回 { n_ctx: 最小值 }
 */
export function resolveAliasNctx(config: Config, alias: string): { n_ctx: number } | undefined {
  const group = config.downstreamModels[alias]
  if (!group || group.disabled === true) return undefined
  const values: number[] = []
  for (const candidate of group.candidates) {
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
 * 别名关闭或未注册 → undefined；
 * 否则遍历候选，收集其 capabilities（空数组/未配置一律忽略），
 * 跨候选按首次出现顺序去重取并集；没有任何候选配置能力 → undefined
 */
export function resolveAliasCapabilities(config: Config, alias: string): string[] | undefined {
  const group = config.downstreamModels[alias]
  if (!group || group.disabled === true) return undefined
  const seen = new Set<string>()
  for (const candidate of group.candidates) {
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
 *
 * 注：本函数对所有 downstreamModels 中的别名聚合，对被总开关关闭的别名也参与计算，
 * 但目前列表类端点已用 listExposedAliases 限制为仅对外暴露的别名，本映射仅供暴露别名消费
 */
export function buildAliasMetaMap(config: Config): Record<string, AliasMeta> {
  const metaMap: Record<string, AliasMeta> = {}
  for (const alias of Object.keys(config.downstreamModels)) {
    if (!isAliasExposed(config, alias)) continue
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

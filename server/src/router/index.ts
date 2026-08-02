// 路由模块：把下游模型别名解析为有序的上游候选列表
// 仅做"别名 → 候选"的静态映射与禁用过滤；负载均衡（T10）、故障回退（T11）不在此处
import type { Config, UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { ModelNotFoundError } from './errors.js'

/**
 * 路由解析器：持有完整配置（含 upstreams 与 downstreamModels），
 * 提供 resolve() 把下游模型别名映射为有序候选列表。
 */
export class Router {
  // 上游 id → 是否禁用 的预计算映射，避免每次 resolve 都线性扫描 upstreams
  private readonly disabledUpstreams: ReadonlyMap<string, boolean>

  constructor(private readonly config: Config) {
    this.disabledUpstreams = new Map(config.upstreams.map((u) => [u.id, u.disabled]))
  }

  /**
   * 解析下游模型别名：
   * - 别名不在 downstreamModels 中 → 抛 ModelNotFoundError
   * - 过滤掉 disabled 上游对应的候选（保留配置顺序）
   * - 若过滤后为空且原列表非空：记警告并返回原列表（全部禁用时交给上层决策）
   */
  resolve(downstreamModel: string): UpstreamCandidate[] {
    const candidates = this.config.downstreamModels[downstreamModel]
    if (!candidates) {
      throw new ModelNotFoundError(downstreamModel)
    }
    // 仅保留未禁用上游的候选
    const active = candidates.filter((c) => this.disabledUpstreams.get(c.upstreamId) !== true)
    if (active.length === 0 && candidates.length > 0) {
      getLogger().warn(
        { downstreamModel },
        '下游模型的所有上游候选均被禁用，按原列表返回',
      )
      return candidates
    }
    return active
  }
}

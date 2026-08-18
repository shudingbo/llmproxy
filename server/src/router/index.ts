// 路由模块：把下游模型别名解析为有序的上游候选列表
// 仅做"别名 → 候选"的静态映射与禁用过滤；负载均衡（T10）、故障回退（T11）不在此处
import type { Config, UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { ModelNotFoundError } from './errors.js'

/**
 * 路由解析器：持有完整配置（含 upstreams 与 downstreamModels），
 * 提供 resolve() 把下游模型别名映射为有序候选列表。
 *
 * 过滤规则：
 * - 别名不在 downstreamModels 中 → 抛 ModelNotFoundError
 * - 别名被整体禁用（alias.disabled === true）→ 抛 ModelNotFoundError（总开关关闭）
 * - 别名未关闭，但所有候选引用的上游都被禁用 → 抛 ModelNotFoundError
 *   （与 listExposedAliases 列表判定对齐，避免出现「列表可见但调用 502」的体验割裂）
 * - 否则按候选顺序返回，过滤掉上游级 disabled 的候选
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
   * - 别名被整体禁用（alias.disabled === true）→ 抛 ModelNotFoundError
   * - 别名开启但所有候选 upstream 都关 → 抛 ModelNotFoundError（与列表端点语义一致）
   * - 否则按顺序返回，过滤掉 upstream.disabled 的候选
   */
  resolve(downstreamModel: string): UpstreamCandidate[] {
    const group = this.config.downstreamModels[downstreamModel]
    if (!group) {
      throw new ModelNotFoundError(downstreamModel)
    }
    // 别名级总开关：true → 整个别名对外不可见，等价于别名未注册
    if (group.disabled === true) {
      getLogger().debug({ downstreamModel }, '下游别名已关闭（别名级总开关），按未注册处理')
      throw new ModelNotFoundError(downstreamModel)
    }
    // 过滤掉 upstream.disabled 的候选
    const active = group.candidates.filter((c) => this.disabledUpstreams.get(c.upstreamId) !== true)
    if (active.length === 0) {
      // 全部候选引用的上游都被禁用：与列表不可见语义对齐，按 model_not_found 处理
      // （避免出现用户看到模型在列表里、调用却 502 的体验割裂）
      getLogger().debug(
        { downstreamModel },
        '下游别名所有候选引用的上游均被禁用，按未注册处理',
      )
      throw new ModelNotFoundError(downstreamModel)
    }
    return active
  }
}

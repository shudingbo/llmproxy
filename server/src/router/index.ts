// 路由模块：把下游模型别名解析为有序的上游候选列表
// 仅做"别名 → 候选"的静态映射与禁用过滤；负载均衡（T10）、故障回退（T11）不在此处
import type { Config, UpstreamCandidate } from '../config/schema.js'
import { getLogger } from '../logger/index.js'
import { ModelNotFoundError } from './errors.js'

/**
 * 路由解析器：持有完整配置（含 upstreams 与 downstreamModels），
 * 提供 resolve() 把下游模型别名映射为有序候选列表。
 *
 * 过滤规则（两层开关，收敛后）：
 * - alias.disabled（别名级总开关）：true → 整个别名不可用，解析即 ModelNotFoundError
 * - upstream.disabled（上游级）：保留原语义，仅跳过该上游对应的候选
 * （候选级 disabled 已移除：临时禁用走 upstream.disabled；永久移除走 Models 页面删除候选）
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
   * - 别名被整体禁用（alias.disabled === true）→ 抛 ModelNotFoundError（总开关关闭）
   * - 过滤掉 disabled 上游对应的候选；若过滤后空但原列表非空：记警告并返回原列表
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
    // 上游级 disabled：仅跳过该候选，其余候选保持原顺序
    const active = group.candidates.filter((c) => this.disabledUpstreams.get(c.upstreamId) !== true)
    console.log("---re",this.disabledUpstreams, active)
    
    if (active.length === 0 && group.candidates.length > 0) {
      getLogger().warn(
        { downstreamModel },
        '下游模型的所有上游候选均被禁用，按原列表返回',
      )
      return group.candidates
    }
    return active
  }
}

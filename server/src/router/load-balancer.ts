// 负载均衡模块：从有序候选列表中选择一个上游候选
// 接口预留扩展点（加权 / 健康检查等），当前仅实现纯内存的轮询（Round Robin）策略
// 计数只保存在内存中：不落盘、无随机、无加权、无外部状态
import type { UpstreamCandidate } from '../config/schema.js'

/**
 * 请求上下文：目前只携带下游模型名，用于按下游模型分桶计数
 */
export interface RequestCtx {
  downstreamModel: string // 用于按下游模型分桶计数
}

/**
 * 负载均衡器接口：从候选列表中挑选一个上游候选
 * 后续可在此接口下扩展加权、健康检查等实现
 */
export interface LoadBalancer {
  pick(candidates: UpstreamCandidate[], ctx: RequestCtx): UpstreamCandidate
}

/**
 * 候选列表为空时抛出，上层（T11 回退逻辑）据此感知没有可用上游
 */
export class EmptyCandidatesError extends Error {
  constructor() {
    super('候选列表为空，无法进行负载均衡选择')
    this.name = 'EmptyCandidatesError'
  }
}

/**
 * 纯内存轮询负载均衡器：
 * - 每个下游模型（ctx.downstreamModel）维护独立的分配计数器
 * - 每次 pick 取出 count % 长度 作为游标，随后计数 +1
 * - 取模让游标自然折回列表头，实现无限轮询；不做随机、不加权、无健康检查
 */
export class RoundRobinLoadBalancer implements LoadBalancer {
  // 下游模型名 → 已分配次数，按模型分桶计数
  private readonly counters = new Map<string, number>()

  pick(candidates: UpstreamCandidate[], ctx: RequestCtx): UpstreamCandidate {
    if (candidates.length === 0) {
      throw new EmptyCandidatesError()
    }
    const key = ctx.downstreamModel
    const count = this.counters.get(key) ?? 0
    const next = count % candidates.length
    this.counters.set(key, count + 1)
    return candidates[next]
  }
}

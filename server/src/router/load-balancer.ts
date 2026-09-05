// 负载均衡模块：从有序候选列表中选择一个上游候选
// 接口预留扩展点（加权 / 健康检查等），当前实现纯内存的轮询（Round Robin）与会话亲和（Session Affinity）两种策略
// 计数只保存在内存中：不落盘、无随机、无加权、无外部状态
import type { UpstreamCandidate } from '../config/schema.js'
import type { SessionBindInfo, SessionUsageRecord } from '../session/db.js'

/**
 * 请求上下文：
 * - downstreamModel：按下游模型分桶计数
 * - sessionKey：会话键（格式 `${downstreamModel}::${raw}`），会话亲和路由据此粘附同一上游
 * - client：会话来源标记（open-webui / content-hash），绑定会话时透传给 SessionStore
 */
export interface RequestCtx {
  downstreamModel: string // 用于按下游模型分桶计数
  sessionKey?: string // 可选：会话亲和路由的会话键，缺省走兜底均衡器
  client?: string // 可选：会话来源标记，仅用于会话绑定时透传
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

/**
 * 会话存储的最小消费接口：会话亲和均衡器只需 get/touch/bind/rebind 四个能力。
 * 真实的 SessionStore 类（../session/db.js）结构上满足该接口；测试可用内存 fake 替代
 */
export interface SessionStoreLike {
  get(sessionKey: string): { upstream_id: string } | undefined
  touch(sessionKey: string): boolean
  bind(sessionKey: string, info: SessionBindInfo): void
  // 改绑上游：请求回退成功后实际成功上游 ≠ 首选时，调用方把会话粘附改绑到成功上游
  rebind(sessionKey: string, upstreamId: string, upstreamModel: string): void
  // 可选：用量统计累加（session/usage.ts 在成功请求后调用；均衡器不需要，测试 fake 可缺省）
  recordUsage?(sessionKey: string, record: SessionUsageRecord): boolean
}

/**
 * 会话亲和负载均衡器：同一会话（sessionKey）的请求粘附同一上游，利用 LLM prompt cache
 * 1. 无 sessionKey → 直接委托兜底均衡器（通常 RoundRobinLoadBalancer）
 * 2. 命中记录且记录的上游仍在候选 → touch 刷新更新时间并返回该候选（保持粘附）
 * 3. 未命中 / 记录上游已不在候选（被删除或禁用）→ 用兜底均衡器重选并 bind 新映射
 */
export class SessionAffinityLoadBalancer implements LoadBalancer {
  constructor(
    private readonly store: SessionStoreLike, // 会话映射存储（真实实现见 ../session/db.js 的 SessionStore）
    private readonly fallback: LoadBalancer, // 兜底均衡器（通常 RoundRobinLoadBalancer）
  ) {}

  pick(candidates: UpstreamCandidate[], ctx: RequestCtx): UpstreamCandidate {
    // 无会话键：无粘附可言，走兜底均衡器
    if (!ctx.sessionKey) {
      return this.fallback.pick(candidates, ctx)
    }
    const { sessionKey } = ctx

    // 命中记录且记录的上游仍在候选列表 → 保持粘附，刷新会话更新时间
    const record = this.store.get(sessionKey)
    if (record) {
      const bound = candidates.find((c) => c.upstreamId === record.upstream_id)
      if (bound) {
        this.store.touch(sessionKey)
        return bound
      }
    }

    // 未命中 / 记录上游已被删除或禁用：重新选择并绑定新映射（覆盖旧映射）
    const picked = this.fallback.pick(candidates, ctx)
    this.store.bind(sessionKey, {
      sessionId: parseRawSessionKey(sessionKey),
      client: ctx.client ?? 'unknown',
      downstreamModel: ctx.downstreamModel,
      upstreamId: picked.upstreamId,
      upstreamModel: picked.model,
    })
    return picked
  }
}

/**
 * 从会话键反解 raw 会话标识：
 * 会话键格式为 `${downstreamModel}::${raw}`，raw 本身可能含 `::`，
 * 故从第一个 `::` 之后取全部；不含 `::` 时直接用会话键本身
 */
function parseRawSessionKey(sessionKey: string): string {
  const sepIndex = sessionKey.indexOf('::')
  if (sepIndex === -1) {
    return sessionKey
  }
  return sessionKey.slice(sepIndex + 2)
}

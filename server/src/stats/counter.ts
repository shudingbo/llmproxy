// 统计计数器：按上游聚合请求次数 / 错误次数 / 总耗时，供管理端 /admin/api/stats 接口使用
// 纯内存计数，不落盘、不持久化；since 标记统计窗口起点（默认构造时刻）
export interface UpstreamStats {
  requests: number
  errors: number
  avgLatencyMs: number
  totalLatencyMs: number
}

// 快照结构：since 为窗口起点 ISO 串，perUpstream 按上游 id 聚合
export interface StatsSnapshot {
  since: string
  perUpstream: Map<string, UpstreamStats>
}

// 单次尝试的计数入参：上游 id、是否成功、耗时毫秒
export interface AttemptInfo {
  upstreamId: string
  ok: boolean
  durationMs: number
}

export class StatsCounter {
  // 统计窗口起点（ISO 时间串），默认构造时刻；可被 setSince 覆盖
  private since: string
  // 上游 id → 原始计数（requests/errors/totalLatencyMs），avgLatencyMs 在快照时计算
  private readonly counters = new Map<string, { requests: number; errors: number; totalLatencyMs: number }>()

  constructor(since?: string) {
    this.since = since ?? new Date().toISOString()
  }

  /** 记录一次上游尝试：成功 / 失败都计一次请求，失败额外计一次错误 */
  recordAttempt({ upstreamId, ok, durationMs }: AttemptInfo): void {
    let entry = this.counters.get(upstreamId)
    if (!entry) {
      entry = { requests: 0, errors: 0, totalLatencyMs: 0 }
      this.counters.set(upstreamId, entry)
    }
    entry.requests += 1
    if (!ok) {
      entry.errors += 1
    }
    entry.totalLatencyMs += durationMs
  }

  /** 生成当前快照：平均耗时 = 总耗时 / 请求数（无请求时为 0） */
  snapshot(): StatsSnapshot {
    const perUpstream = new Map<string, UpstreamStats>()
    for (const [id, entry] of this.counters) {
      perUpstream.set(id, {
        requests: entry.requests,
        errors: entry.errors,
        avgLatencyMs: entry.requests > 0 ? entry.totalLatencyMs / entry.requests : 0,
        totalLatencyMs: entry.totalLatencyMs,
      })
    }
    return { since: this.since, perUpstream }
  }

  /** 覆盖统计窗口起点（管理端重置统计时使用） */
  setSince(iso: string): void {
    this.since = iso
  }
}

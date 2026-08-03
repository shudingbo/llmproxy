// StatsCounter 单元测试：计数、快照聚合、窗口起点覆盖
import { describe, expect, it } from 'vitest'
import { StatsCounter } from '../../src/stats/counter.js'

describe('StatsCounter', () => {
  it('无参构造时 since 默认为当前 ISO 时间串', () => {
    const counter = new StatsCounter()
    const since = counter.snapshot().since
    // 合法 ISO 串往返一致即视为有效时间
    expect(new Date(since).toISOString()).toBe(since)
  })

  it('recordAttempt 累加请求 / 错误 / 总耗时，快照计算平均耗时', () => {
    const counter = new StatsCounter('2026-08-02T00:00:00.000Z')
    counter.recordAttempt({ upstreamId: 'u1', ok: true, durationMs: 100 })
    counter.recordAttempt({ upstreamId: 'u1', ok: false, durationMs: 50 })
    counter.recordAttempt({ upstreamId: 'u2', ok: false, durationMs: 30 })

    const snap = counter.snapshot()
    expect(snap.since).toBe('2026-08-02T00:00:00.000Z')
    expect(snap.perUpstream.get('u1')).toEqual({ requests: 2, errors: 1, avgLatencyMs: 75, totalLatencyMs: 150 })
    expect(snap.perUpstream.get('u2')).toEqual({ requests: 1, errors: 1, avgLatencyMs: 30, totalLatencyMs: 30 })
  })

  it('setSince 覆盖窗口起点', () => {
    const counter = new StatsCounter('2026-08-02T00:00:00.000Z')
    counter.setSince('2026-08-03T00:00:00.000Z')
    expect(counter.snapshot().since).toBe('2026-08-03T00:00:00.000Z')
  })

  it('无记录时快照为空 Map，不产生 NaN', () => {
    const counter = new StatsCounter('2026-08-02T00:00:00.000Z')
    const snap = counter.snapshot()
    expect(snap.perUpstream.size).toBe(0)
  })
})

// 负载均衡测试：轮询策略（顺序轮询、计数独立、单候选恒等、空候选抛错）+ 会话亲和策略（粘附 / 重绑 / 委托）
// 会话亲和用例使用内存 fake SessionStore 与记录型兜底均衡器，不依赖真实会话存储模块
import { describe, expect, it, vi } from 'vitest'
import type { UpstreamCandidate } from '../../src/config/schema.js'
import type { SessionBindInfo } from '../../src/session/db.js'
import { executeWithFallback } from '../../src/router/fallback.js'
import {
  EmptyCandidatesError,
  RoundRobinLoadBalancer,
  SessionAffinityLoadBalancer,
  type LoadBalancer,
  type RequestCtx,
  type SessionStoreLike,
} from '../../src/router/load-balancer.js'

// 3 个候选 A/B/C
const abc: UpstreamCandidate[] = [
  { upstreamId: 'a', model: 'm-a' },
  { upstreamId: 'b', model: 'm-b' },
  { upstreamId: 'c', model: 'm-c' },
]

// 内存 fake SessionStore：实现 get/touch/bind/rebind 并记录调用，供会话亲和测试断言
class FakeSessionStore implements SessionStoreLike {
  records = new Map<string, { upstream_id: string }>()
  touchCalls: string[] = []
  bindCalls: Array<{ sessionKey: string; info: SessionBindInfo }> = []
  rebindCalls: Array<{ sessionKey: string; upstreamId: string; upstreamModel: string }> = []

  get(sessionKey: string): { upstream_id: string } | undefined {
    const record = this.records.get(sessionKey)
    return record ? { upstream_id: record.upstream_id } : undefined
  }

  touch(sessionKey: string): boolean {
    this.touchCalls.push(sessionKey)
    return this.records.has(sessionKey)
  }

  bind(sessionKey: string, info: SessionBindInfo): void {
    this.bindCalls.push({ sessionKey, info })
    this.records.set(sessionKey, { upstream_id: info.upstreamId })
  }

  rebind(sessionKey: string, upstreamId: string, upstreamModel: string): void {
    this.rebindCalls.push({ sessionKey, upstreamId, upstreamModel })
    this.records.set(sessionKey, { upstream_id: upstreamId })
  }
}

// 记录型兜底均衡器：记录每次 pick 的候选/ctx，按固定顺序轮询返回
class RecordingFallback implements LoadBalancer {
  picks: Array<{ candidates: UpstreamCandidate[]; ctx: RequestCtx }> = []
  private cursor = 0

  pick(candidates: UpstreamCandidate[], ctx: RequestCtx): UpstreamCandidate {
    this.picks.push({ candidates, ctx })
    const picked = candidates[this.cursor % candidates.length]
    this.cursor += 1
    return picked
  }
}

describe('RoundRobinLoadBalancer.pick', () => {
  it('3 个候选连续调用 6 次按 A/B/C 顺序轮询', () => {
    const lb = new RoundRobinLoadBalancer()
    const picked = Array.from({ length: 6 }, () => lb.pick(abc, { downstreamModel: 'gpt-4' }))
    expect(picked.map((p) => p.upstreamId)).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('两个实例、不同下游模型 ctx 计数各自独立', () => {
    const lb1 = new RoundRobinLoadBalancer()
    const lb2 = new RoundRobinLoadBalancer()
    // lb1 的 gpt-4 桶先消费一轮，不影响 lb2
    expect(lb1.pick(abc, { downstreamModel: 'gpt-4' }).upstreamId).toBe('a')
    expect(lb1.pick(abc, { downstreamModel: 'gpt-4' }).upstreamId).toBe('b')
    expect(lb1.pick(abc, { downstreamModel: 'gpt-4' }).upstreamId).toBe('c')
    // lb2 从自身起点开始（尚未消费）
    expect(lb2.pick(abc, { downstreamModel: 'gpt-4' }).upstreamId).toBe('a')
    // 同一实例内不同下游模型也独立
    expect(lb1.pick(abc, { downstreamModel: 'llama3' }).upstreamId).toBe('a')
    // lb1 的 gpt-4 桶继续轮询，折回列表头
    expect(lb1.pick(abc, { downstreamModel: 'gpt-4' }).upstreamId).toBe('a')
  })

  it('单个候选连续 5 次始终返回同一个', () => {
    const lb = new RoundRobinLoadBalancer()
    const single: UpstreamCandidate[] = [{ upstreamId: 'only', model: 'm-only' }]
    const picked = Array.from({ length: 5 }, () => lb.pick(single, { downstreamModel: 'gpt-4' }))
    expect(picked.every((p) => p.upstreamId === 'only')).toBe(true)
  })

  it('空候选列表抛 EmptyCandidatesError', () => {
    const lb = new RoundRobinLoadBalancer()
    try {
      lb.pick([], { downstreamModel: 'gpt-4' })
      expect.unreachable('应当抛出 EmptyCandidatesError')
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyCandidatesError)
    }
  })
})

describe('SessionAffinityLoadBalancer.pick', () => {
  it('无 sessionKey 时直接委托兜底均衡器，不触碰会话存储', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)

    const picked = lb.pick(abc, { downstreamModel: 'gpt-4' })

    expect(picked.upstreamId).toBe('a') // 兜底轮询第一个
    expect(fallback.picks).toHaveLength(1)
    expect(fallback.picks[0].ctx).toEqual({ downstreamModel: 'gpt-4' })
    expect(store.touchCalls).toHaveLength(0)
    expect(store.bindCalls).toHaveLength(0)
  })

  it('命中记录且上游仍可用时保持粘附：返回记录上游、touch、不 bind', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    store.records.set('gpt-4::sess-1', { upstream_id: 'b' })
    const lb = new SessionAffinityLoadBalancer(store, fallback)

    const picked = lb.pick(abc, { downstreamModel: 'gpt-4', sessionKey: 'gpt-4::sess-1' })

    expect(picked.upstreamId).toBe('b')
    expect(store.touchCalls).toEqual(['gpt-4::sess-1'])
    expect(store.bindCalls).toHaveLength(0)
    expect(fallback.picks).toHaveLength(0)
  })

  it('未命中时用兜底均衡器选择并绑定新映射（sessionId 反解、client 透传、模型一致）', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)
    const ctx: RequestCtx = { downstreamModel: 'gpt-4', sessionKey: 'gpt-4::chat-123', client: 'open-webui' }

    const picked = lb.pick(abc, ctx)

    expect(picked.upstreamId).toBe('a')
    expect(fallback.picks).toHaveLength(1)
    expect(store.bindCalls).toHaveLength(1)
    expect(store.bindCalls[0].sessionKey).toBe('gpt-4::chat-123')
    expect(store.bindCalls[0].info).toEqual({
      sessionId: 'chat-123',
      client: 'open-webui',
      downstreamModel: 'gpt-4',
      upstreamId: 'a',
      upstreamModel: 'm-a',
    })
    // 绑定后同一会话再次 pick 直接命中新映射
    const picked2 = lb.pick(abc, ctx)
    expect(picked2.upstreamId).toBe('a')
    expect(store.touchCalls).toEqual(['gpt-4::chat-123'])
  })

  it('未命中且未提供 client 时绑定默认 unknown', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)

    lb.pick(abc, { downstreamModel: 'llama3', sessionKey: 'llama3::sess-x' })

    expect(store.bindCalls[0].info.client).toBe('unknown')
  })

  it('记录上游不在候选列表（被删/禁用）时重新选择并覆盖旧映射', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    store.records.set('gpt-4::sess-2', { upstream_id: 'gone' })
    const lb = new SessionAffinityLoadBalancer(store, fallback)
    const ctx: RequestCtx = { downstreamModel: 'gpt-4', sessionKey: 'gpt-4::sess-2' }

    const picked = lb.pick(abc, ctx)

    expect(picked.upstreamId).toBe('a')
    expect(store.bindCalls).toHaveLength(1)
    expect(store.bindCalls[0].info.upstreamId).toBe('a')
    // 旧映射已被新映射覆盖：再次 pick 命中 a 且不再 bind
    const picked2 = lb.pick(abc, ctx)
    expect(picked2.upstreamId).toBe('a')
    expect(store.bindCalls).toHaveLength(1)
  })

  it('同一会话多次 pick 始终粘附同一上游（不随兜底轮询漂移）', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)
    const ctx: RequestCtx = { downstreamModel: 'gpt-4', sessionKey: 'gpt-4::stable' }

    const first = lb.pick(abc, ctx)
    const picked = Array.from({ length: 5 }, () => lb.pick(abc, ctx))

    expect(picked.every((p) => p.upstreamId === first.upstreamId)).toBe(true)
    expect(store.bindCalls).toHaveLength(1)
    expect(store.touchCalls).toHaveLength(5)
  })

  it('sessionKey 含多个 :: 时从第一个 :: 之后反解完整 raw', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)

    lb.pick(abc, { downstreamModel: 'gpt-4', sessionKey: 'gpt-4::chat::sub::id' })

    expect(store.bindCalls[0].info.sessionId).toBe('chat::sub::id')
  })

  it('sessionKey 不含 :: 时 raw 即会话键本身', () => {
    const fallback = new RecordingFallback()
    const store = new FakeSessionStore()
    const lb = new SessionAffinityLoadBalancer(store, fallback)

    lb.pick(abc, { downstreamModel: 'gpt-4', sessionKey: 'plain-key' })

    expect(store.bindCalls[0].info.sessionId).toBe('plain-key')
  })
})

describe('executeWithFallback.onSuccess', () => {
  it('首候选失败回退成功后，onSuccess 收到实际成功的候选', async () => {
    const onSuccess = vi.fn()
    const lb = new RoundRobinLoadBalancer()

    const result = await executeWithFallback(
      abc,
      lb,
      { downstreamModel: 'gpt-4' },
      async (candidate) => {
        if (candidate.upstreamId === 'a') {
          return { ok: false, error: new Error('boom'), fallbackable: true }
        }
        return { ok: true, value: { text: 'ok' } }
      },
      onSuccess,
    )

    expect(result.ok).toBe(true)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(abc[1]) // 第二个候选 b 实际成功
  })

  it('不传 onSuccess 时行为与原来完全一致', async () => {
    const lb = new RoundRobinLoadBalancer()

    const result = await executeWithFallback(
      abc,
      lb,
      { downstreamModel: 'gpt-4' },
      async (candidate) => {
        if (candidate.upstreamId === 'a') {
          return { ok: false, error: new Error('boom'), fallbackable: true }
        }
        return { ok: true, value: { text: 'ok' } }
      },
    )

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ text: 'ok' })
    expect(result.attemptLog).toHaveLength(2)
  })

  it('全部失败时不调用 onSuccess', async () => {
    const onSuccess = vi.fn()
    const lb = new RoundRobinLoadBalancer()

    const result = await executeWithFallback(
      abc,
      lb,
      { downstreamModel: 'gpt-4' },
      async () => ({ ok: false, error: new Error('boom'), fallbackable: true }),
      onSuccess,
    )

    expect(result.ok).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

// 轮询负载均衡测试：顺序轮询、实例/模型间计数独立、单候选恒等、空候选抛错
import { describe, expect, it } from 'vitest'
import type { UpstreamCandidate } from '../config/schema.js'
import { EmptyCandidatesError, RoundRobinLoadBalancer } from './load-balancer.js'

// 3 个候选 A/B/C
const abc: UpstreamCandidate[] = [
  { upstreamId: 'a', model: 'm-a' },
  { upstreamId: 'b', model: 'm-b' },
  { upstreamId: 'c', model: 'm-c' },
]

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

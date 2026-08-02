// 顺序回退执行器测试：命中即止、可回退继续、不可回退中断、wrap 顺序、全失败返回末错
import { describe, expect, it } from 'vitest'
import type { UpstreamCandidate } from '../config/schema.js'
import { EmptyCandidatesError, RoundRobinLoadBalancer } from './load-balancer.js'
import { executeWithFallback, isFallbackableAxiosError } from './fallback.js'

// 3 个候选 A/B/C
const abc: UpstreamCandidate[] = [
  { upstreamId: 'a', model: 'm-a' },
  { upstreamId: 'b', model: 'm-b' },
  { upstreamId: 'c', model: 'm-c' },
]

describe('executeWithFallback', () => {
  it('第一个候选成功：返回其 value，只记录 1 次尝试', async () => {
    const lb = new RoundRobinLoadBalancer()
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async (c) => ({
      ok: true as const,
      value: { upstreamId: c.upstreamId, status: 200 },
    }))
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ upstreamId: 'a', status: 200 })
    expect(res.attemptLog).toHaveLength(1)
    expect(res.attemptLog[0]).toMatchObject({
      upstreamId: 'a',
      model: 'm-a',
      status: 200,
      fallbackable: false,
    })
  })

  it('A 可回退失败、B 成功：返回 B，2 次尝试', async () => {
    const lb = new RoundRobinLoadBalancer()
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async (c) => {
      if (c.upstreamId === 'a') {
        return { ok: false as const, error: Object.assign(new Error('server error'), { code: '500' }), fallbackable: true }
      }
      return { ok: true as const, value: { upstreamId: c.upstreamId } }
    })
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ upstreamId: 'b' })
    expect(res.attemptLog.map((e) => e.upstreamId)).toEqual(['a', 'b'])
    expect(res.attemptLog[0]).toMatchObject({ fallbackable: true, errorCode: '500' })
    expect(res.attemptLog[1]).toMatchObject({ fallbackable: false })
  })

  it('全部可回退失败：返回最后一个错误，3 次尝试', async () => {
    const lb = new RoundRobinLoadBalancer()
    const errors = ['err-a', 'err-b', 'err-c']
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async (c) => ({
      ok: false as const,
      error: new Error(errors[abc.findIndex((x) => x.upstreamId === c.upstreamId)]),
      fallbackable: true,
    }))
    expect(res.ok).toBe(false)
    expect((res.error as Error).message).toBe('err-c') // 最后一个错误
    expect(res.attemptLog.map((e) => e.upstreamId)).toEqual(['a', 'b', 'c'])
    expect(res.attemptLog.every((e) => e.fallbackable)).toBe(true)
  })

  it('wrap 顺序：起点为 C 时按 [C, A, B] 尝试，A 失败后 B 成功', async () => {
    // 预先把轮询计数推进到 2（count % 3 === 2 → 起点 C）
    const lb = new RoundRobinLoadBalancer()
    lb.pick(abc, { downstreamModel: 'gpt-4' })
    lb.pick(abc, { downstreamModel: 'gpt-4' })
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async (c) => {
      if (c.upstreamId === 'b') {
        return { ok: true as const, value: { upstreamId: c.upstreamId } }
      }
      return { ok: false as const, error: new Error('500'), fallbackable: true }
    })
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ upstreamId: 'b' })
    // 尝试顺序从 C 开始 wrap：C → A → B
    expect(res.attemptLog.map((e) => e.upstreamId)).toEqual(['c', 'a', 'b'])
  })

  it('调用方把 400 标记为不可回退：只尝试 1 次并返回该错误', async () => {
    const lb = new RoundRobinLoadBalancer()
    const err400 = Object.assign(new Error('bad request'), { status: 400 })
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async () => ({
      ok: false as const,
      error: err400,
      fallbackable: false,
    }))
    expect(res.ok).toBe(false)
    expect(res.error).toBe(err400)
    expect(res.attemptLog).toHaveLength(1)
    expect(res.attemptLog[0]).toMatchObject({ upstreamId: 'a', fallbackable: false, errorCode: '400' })
  })

  it('全部失败（均可回退）时 errorCode 记录网络错误代号', async () => {
    const lb = new RoundRobinLoadBalancer()
    const res = await executeWithFallback(abc, lb, { downstreamModel: 'gpt-4' }, async (c) => {
      if (c.upstreamId === 'a') {
        return { ok: false as const, error: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), fallbackable: true }
      }
      if (c.upstreamId === 'b') {
        return { ok: false as const, error: Object.assign(new Error('bad gateway'), { status: 502 }), fallbackable: true }
      }
      return { ok: false as const, error: new Error('timeout'), fallbackable: true }
    })
    expect(res.ok).toBe(false)
    // code 字段优先，其次 status，最后无代号 → undefined
    expect(res.attemptLog.map((e) => e.errorCode)).toEqual(['ECONNREFUSED', '502', undefined])
  })

  it('空候选列表抛 EmptyCandidatesError', async () => {
    const lb = new RoundRobinLoadBalancer()
    try {
      await executeWithFallback([], lb, { downstreamModel: 'gpt-4' }, async () => ({ ok: true as const, value: 1 }))
      expect.unreachable('应当抛出 EmptyCandidatesError')
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyCandidatesError)
    }
  })
})

describe('isFallbackableAxiosError', () => {
  it('网络错误与 429/5xx 可回退', () => {
    expect(isFallbackableAxiosError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isFallbackableAxiosError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true)
    expect(isFallbackableAxiosError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isFallbackableAxiosError(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))).toBe(true)
    expect(
      isFallbackableAxiosError(Object.assign(new Error('too many'), { isAxiosError: true, response: { status: 429 } })),
    ).toBe(true)
    expect(
      isFallbackableAxiosError(Object.assign(new Error('server'), { isAxiosError: true, response: { status: 503 } })),
    ).toBe(true)
    // 上游超时：axios 的 message 含 timeout
    expect(isFallbackableAxiosError(Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true }))).toBe(true)
  })

  it('401/403 与普通 4xx 不可回退', () => {
    expect(
      isFallbackableAxiosError(Object.assign(new Error('unauthorized'), { isAxiosError: true, response: { status: 401 } })),
    ).toBe(false)
    expect(
      isFallbackableAxiosError(Object.assign(new Error('forbidden'), { isAxiosError: true, response: { status: 403 } })),
    ).toBe(false)
    expect(
      isFallbackableAxiosError(Object.assign(new Error('not found'), { isAxiosError: true, response: { status: 404 } })),
    ).toBe(false)
  })
})

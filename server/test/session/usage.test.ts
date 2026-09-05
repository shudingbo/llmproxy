// session/usage.ts 单元测试：usage 提取（chat / responses 非流式形状）+ SseUsageTap（chat / responses 两种 SSE 口径的
// 首 token 时延与 usage 捕获、跨 chunk 行切分、finish 幂等）+ recordSessionUsage（失败隔离 / no-op 分支）
// 不碰 DB：recordSessionUsage 用内存 fake store；SseUsageTap 用回拨的 hrtime 起点做确定性断言
import { describe, expect, it } from 'vitest'
import {
  __resetUsageWriteFailedForTest,
  extractChatUsage,
  extractResponsesUsage,
  recordSessionUsage,
  SseUsageTap,
  type TimingStats,
  type UsageSnapshot,
} from '../../src/session/usage.js'
import type { SessionUsageRecord } from '../../src/session/db.js'

// 100ms 前的 hrtime 时刻作为 TTFT 零点：feed 后立即测量 → firstTokenMs ≈ 100ms（确定性断言下界）
const BACKDATED_100MS = 100_000_000n

// 记录 onDone 回调的 tap 工厂
const makeTap = (kind: 'chat' | 'responses'): {
  tap: SseUsageTap
  done: Array<{ usage: UsageSnapshot | null; timing: TimingStats }>
} => {
  const done: Array<{ usage: UsageSnapshot | null; timing: TimingStats }> = []
  const tap = new SseUsageTap({
    kind,
    startedAt: process.hrtime.bigint() - BACKDATED_100MS,
    onDone: (usage, timing) => done.push({ usage, timing }),
  })
  return { tap, done }
}

// 标准 chat SSE 流：role-only 首块 → 两个内容块 → 末尾 usage 块 → [DONE]
const CHAT_SSE =
  'data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"id":"2","choices":[{"delta":{"content":"你"}}]}\n\n' +
  'data: {"id":"3","choices":[{"delta":{"content":"好"}}]}\n\n' +
  'data: {"id":"4","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n' +
  'data: [DONE]\n\n'

// 标准 responses SSE 流：两个正文 delta → response.completed（内嵌 usage）
const RESPONSES_SSE =
  'data: {"type":"response.output_text.delta","item_id":"m1","delta":"你"}\n\n' +
  'data: {"type":"response.output_text.delta","item_id":"m1","delta":"好"}\n\n' +
  'data: {"type":"response.completed","response":{"id":"r1","object":"response","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}}\n\n'

describe('extractChatUsage', () => {
  it('完整 usage → 快照（字段直取）', () => {
    expect(
      extractChatUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
    ).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
  })

  it('total_tokens 缺失 → 输入 + 输出之和', () => {
    expect(
      extractChatUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } }),
    ).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
  })

  it('usage 缺失 / 结构不符 / 全 0 / 非对象 → null', () => {
    expect(extractChatUsage({})).toBeNull()
    expect(extractChatUsage(null)).toBeNull()
    expect(extractChatUsage('x')).toBeNull()
    expect(extractChatUsage({ usage: 'oops' })).toBeNull()
    expect(extractChatUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })).toBeNull()
  })

  it('非法数值（负数 / NaN / 字符串）按 0 收敛；全字段非法 → null', () => {
    expect(extractChatUsage({ usage: { prompt_tokens: -5, completion_tokens: 8, total_tokens: 'x' } })).toEqual({
      promptTokens: 0,
      completionTokens: 8,
      totalTokens: 8,
    })
    expect(extractChatUsage({ usage: { prompt_tokens: NaN } })).toBeNull()
  })
})

describe('extractResponsesUsage', () => {
  it('response.usage（input_tokens / output_tokens / total_tokens）→ 归一化快照', () => {
    expect(
      extractResponsesUsage({ usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } }),
    ).toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 })
  })

  it('total_tokens 缺失 → 输入 + 输出之和；usage 缺失 → null', () => {
    expect(extractResponsesUsage({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    })
    expect(extractResponsesUsage({})).toBeNull()
    expect(extractResponsesUsage(null)).toBeNull()
  })
})

describe('SseUsageTap（chat 口径）', () => {
  it('完整流：TTFT 取首个内容 delta（role-only 首块不计）+ 末尾 usage 块 + 生成时长', () => {
    const { tap, done } = makeTap('chat')
    tap.feed(CHAT_SSE)
    tap.finish()

    expect(done).toHaveLength(1)
    const { usage, timing } = done[0]!
    // 起点回拨 100ms：首 token 时延 ≈ 100ms（上界放宽到 5s 防极端抖动）
    expect(timing.firstTokenMeasured).toBe(1)
    expect(timing.firstTokenMs).toBeGreaterThanOrEqual(100)
    expect(timing.firstTokenMs).toBeLessThan(5000)
    // 生成时长 = 流结束 − 首 token（feed 与 finish 之间微秒级）
    expect(timing.generationMs).toBeGreaterThanOrEqual(0)
    expect(timing.generationMs).toBeLessThan(5000)
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
  })

  it('reasoning_content 先于正文 → TTFT 记在思考 delta（推理模型首 token 是思考）', () => {
    const { tap, done } = makeTap('chat')
    tap.feed(
      'data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"id":"2","choices":[{"delta":{"reasoning_content":"嗯…"}}]}\n\n' +
        'data: {"id":"3","choices":[{"delta":{"content":"你好"}}]}\n\n',
    )
    tap.finish()

    expect(done).toHaveLength(1)
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
    expect(done[0]!.usage).toBeNull() // 无 usage 块
  })

  it('无任何内容 delta 且无 usage（空流 / 提前中断）→ 计时全 0、usage null', () => {
    const { tap, done } = makeTap('chat')
    tap.feed('data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}\n\n')
    tap.finish()

    expect(done).toHaveLength(1)
    expect(done[0]!.timing).toEqual({ firstTokenMs: 0, firstTokenMeasured: 0, generationMs: expect.any(Number) })
    expect(done[0]!.timing.generationMs).toBeGreaterThanOrEqual(100) // 无首 token → 取全程（≈100ms 回拨）
    expect(done[0]!.usage).toBeNull()
  })

  it('单条 data 行跨多个 chunk → 仍能完整解析', () => {
    const { tap, done } = makeTap('chat')
    // 把 usage 行拆成三段喂入（含 \n 边界两侧）
    tap.feed('data: {"id":"4","choices":[],"us')
    tap.feed('age":{"prompt_tokens":1,"compl')
    tap.feed('etion_tokens":2,"total_tokens":3}}\n\n')
    tap.feed('data: {"id":"2","choices":[{"delta":{"content":"你"}}]}\n\n')
    tap.finish()

    expect(done).toHaveLength(1)
    expect(done[0]!.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
  })

  it('finish 幂等：end 后 close 再触发 → onDone 仅一次；finish 后 feed 为 no-op', () => {
    const { tap, done } = makeTap('chat')
    tap.feed(CHAT_SSE)
    tap.finish()
    tap.finish() // close 事件（中断路径）晚于 end 到达
    tap.feed('data: {"id":"9","choices":[{"delta":{"content":"x"}}]}\n\n')
    expect(done).toHaveLength(1)
  })

  it('非 JSON 的 data 行静默跳过（不抛错、不影响后续解析）', () => {
    const { tap, done } = makeTap('chat')
    tap.feed('data: not-json\n\ndata: {"id":"2","choices":[{"delta":{"content":"你"}}]}\n\n')
    tap.finish()
    expect(done).toHaveLength(1)
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
  })
})

describe('SseUsageTap（responses 口径）', () => {
  it('完整流：TTFT 取首个 output_text delta + response.completed 内 usage', () => {
    const { tap, done } = makeTap('responses')
    tap.feed(RESPONSES_SSE)
    tap.finish()

    expect(done).toHaveLength(1)
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
    expect(done[0]!.timing.firstTokenMs).toBeGreaterThanOrEqual(100)
    expect(done[0]!.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
  })

  it('reasoning delta 先于正文 → TTFT 记在思考 delta', () => {
    const { tap, done } = makeTap('responses')
    tap.feed(
      'data: {"type":"response.reasoning_text.delta","delta":"嗯…"}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"你好"}\n\n',
    )
    tap.finish()
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
    expect(done[0]!.usage).toBeNull()
  })

  it('response.completed 无 usage（上游未返回）→ usage null、TTFT 正常', () => {
    const { tap, done } = makeTap('responses')
    tap.feed(
      'data: {"type":"response.output_text.delta","delta":"你好"}\n\n' +
        'data: {"type":"response.completed","response":{"id":"r1","object":"response"}}\n\n',
    )
    tap.finish()
    expect(done[0]!.timing.firstTokenMeasured).toBe(1)
    expect(done[0]!.usage).toBeNull()
  })
})

describe('recordSessionUsage', () => {
  // 内存 fake store：记录写入；可切换为抛错（模拟 DB 写失败）
  class FakeUsageStore {
    records: SessionUsageRecord[] = []
    fail = false
    recordUsage(_key: string, record: SessionUsageRecord): boolean {
      if (this.fail) {
        throw new Error('db down')
      }
      this.records.push(record)
      return true
    }
  }

  it('store / recordUsage / sessionKey 缺失 → no-op（不抛错）', () => {
    expect(() => recordSessionUsage(undefined, 'k::1', null, { firstTokenMs: 0, firstTokenMeasured: 0, generationMs: 1 })).not.toThrow()
    expect(() => recordSessionUsage({}, 'k::1', null, { firstTokenMs: 0, firstTokenMeasured: 0, generationMs: 1 })).not.toThrow()
    const store = new FakeUsageStore()
    expect(() => recordSessionUsage(store, undefined, null, { firstTokenMs: 0, firstTokenMeasured: 0, generationMs: 1 })).not.toThrow()
    expect(store.records).toHaveLength(0)
  })

  it('正常写入：usage null → token 全 0；计时指标原样透传', () => {
    const store = new FakeUsageStore()
    recordSessionUsage(store, 'gpt-4::s1', null, { firstTokenMs: 0, firstTokenMeasured: 0, generationMs: 512 })
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      firstTokenMs: 0,
      firstTokenMeasured: 0,
      generationMs: 512,
    })
  })

  it('usage 快照 → token 字段原样写入', () => {
    const store = new FakeUsageStore()
    recordSessionUsage(store, 'gpt-4::s1', { promptTokens: 11, completionTokens: 22, totalTokens: 33 }, {
      firstTokenMs: 150,
      firstTokenMeasured: 1,
      generationMs: 2000,
    })
    expect(store.records[0]).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      firstTokenMs: 150,
      firstTokenMeasured: 1,
      generationMs: 2000,
    })
  })

  it('DB 写失败 → 不抛错（告警一次隔离，业务请求不受影响）', () => {
    __resetUsageWriteFailedForTest()
    const store = new FakeUsageStore()
    store.fail = true
    expect(() =>
      recordSessionUsage(store, 'gpt-4::s1', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, {
        firstTokenMs: 0,
        firstTokenMeasured: 0,
        generationMs: 10,
      }),
    ).not.toThrow()
    expect(store.records).toHaveLength(0)
    // 后续同类失败静默（不再告警）——仍不抛错
    expect(() =>
      recordSessionUsage(store, 'gpt-4::s1', null, { firstTokenMs: 0, firstTokenMeasured: 0, generationMs: 10 }),
    ).not.toThrow()
    __resetUsageWriteFailedForTest()
  })
})

// convertChatResponse 单元测试（T14）：OpenAI → Ollama 非流式响应映射
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLogger } from '../logger/index.js'
import { convertChatResponse, mapFinishReason } from './openai-to-ollama-response.js'

// 固定 unix 秒（对应 2023-11-14T22:13:20Z），用于断言 created_at 精确值
const FIXED_CREATED = 1_700_000_000
const FIXED_CREATED_ISO = '2023-11-14T22:13:20.000Z'

// 构造最小 OpenAI 非流式响应，可覆盖任意字段
function openaiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    created: FIXED_CREATED,
    choices: [
      { index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('convertChatResponse 基本映射', () => {
  it('内容 + usage → done:true、prompt_eval_count、eval_count、ISO created_at', () => {
    const result = convertChatResponse(openaiResponse(), 'qwen2.5')
    expect(result).toEqual({
      model: 'qwen2.5',
      created_at: FIXED_CREATED_ISO,
      message: { role: 'assistant', content: '你好' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 34,
    })
  })

  it('不修改入参（原响应保持原样）', () => {
    const input = openaiResponse()
    const snapshot = JSON.parse(JSON.stringify(input))
    convertChatResponse(input, 'qwen2.5')
    expect(input).toEqual(snapshot)
  })
})

describe('done_reason 映射', () => {
  it("finish_reason 'stop' → done_reason 'stop'", () => {
    const result = convertChatResponse(
      openaiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
      'qwen2.5',
    )
    expect(result.done_reason).toBe('stop')
  })

  it("finish_reason 'length' → done_reason 'length'", () => {
    const result = convertChatResponse(
      openaiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }),
      'qwen2.5',
    )
    expect(result.done_reason).toBe('length')
  })

  it('未知 / 缺失 finish_reason → 省略 done_reason 字段', () => {
    const result = convertChatResponse(
      openaiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] }),
      'qwen2.5',
    )
    expect('done_reason' in result).toBe(false)
    expect(mapFinishReason(undefined)).toBeNull()
    expect(mapFinishReason('weird')).toBeNull()
  })
})

describe('tool_calls 处理', () => {
  it('存在 tool_calls 时从 message 丢弃并记 warn 日志', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const result = convertChatResponse(
      openaiResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'x', tool_calls: [{ id: 'call_1' }] },
            finish_reason: 'stop',
          },
        ],
      }),
      'qwen2.5',
    )
    // 丢弃后 message 不含 tool_calls
    const msg = result.message as Record<string, unknown>
    expect('tool_calls' in msg).toBe(false)
    expect(result.message).toEqual({ role: 'assistant', content: 'x' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('choices 校验', () => {
  it('choices 为空数组 → 抛 Error(choices empty)', () => {
    let caught: unknown
    try {
      convertChatResponse(openaiResponse({ choices: [] }), 'qwen2.5')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('choices empty')
  })
})

describe('created 缺失回退', () => {
  it('created 缺失时使用当前时间（fake Date）', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'))
    try {
      const result = convertChatResponse(openaiResponse({ created: undefined }), 'qwen2.5')
      expect(result.created_at).toBe('2026-08-02T00:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })
})

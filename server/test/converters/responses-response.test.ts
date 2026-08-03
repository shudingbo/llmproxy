// Chat → Responses 非流式响应转换器测试
// 覆盖：content/usage 映射、空 content 兜底、无 usage 省略字段、响应形状与 id 前缀
import { describe, expect, it } from 'vitest'
import type { UpstreamChatResponse } from '../../src/upstream/openai.js'
import { chatResponseToResponses } from '../../src/converters/responses-response.js'

// 构造最小 chat 响应（宽松类型，字段可缺省）
const chatRes = (partial: Partial<UpstreamChatResponse>): UpstreamChatResponse => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...partial,
})

describe('chatResponseToResponses', () => {
  it('content 与 usage 映射为 Responses 字段', () => {
    const result = chatResponseToResponses(chatRes({}), 'gpt-4')
    expect(result.object).toBe('response')
    expect(result.status).toBe('completed')
    expect(result.model).toBe('gpt-4')
    expect(typeof result.created_at).toBe('number')
    expect(result.id.startsWith('resp_')).toBe(true)
    expect(result.output).toHaveLength(1)
    const message = result.output[0]
    expect(message).toMatchObject({ type: 'message', role: 'assistant', status: 'completed' })
    expect(message.id.startsWith('msg_')).toBe(true)
    expect(message.content).toEqual([{ type: 'output_text', text: '你好', annotations: [] }])
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
  })

  it('choices[0].message.content 为 null / 缺失 → 空串输出', () => {
    const nullResult = chatResponseToResponses(
      chatRes({ choices: [{ index: 0, message: { role: 'assistant', content: null as unknown as string } }] }),
      'gpt-4',
    )
    expect(nullResult.output[0].content[0].text).toBe('')
    const missingResult = chatResponseToResponses(chatRes({ choices: [] }), 'gpt-4')
    expect(missingResult.output[0].content[0].text).toBe('')
  })

  it('上游无 usage → 响应省略 usage 字段', () => {
    const result = chatResponseToResponses(chatRes({ usage: undefined }), 'gpt-4')
    expect('usage' in result).toBe(false)
  })

  it('usage 字段缺省 → 映射为 0 兜底', () => {
    const result = chatResponseToResponses(
      chatRes({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      'gpt-4',
    )
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })
  })

  it('绝不修改入参对象', () => {
    const input = chatRes({})
    const snapshot = structuredClone(input)
    chatResponseToResponses(input, 'gpt-4')
    expect(input).toEqual(snapshot)
  })
})

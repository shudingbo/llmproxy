// Responses → Chat 请求转换器测试
// 覆盖：string input、数组 input、instructions 前置、多模态 content 文本提取、
// max_output_tokens 映射、参数透传、入参不可变、不可映射项忽略
import { describe, expect, it } from 'vitest'
import { responsesRequestToChat, responsesToChatMessages, type ResponsesChatMessage } from './responses-request.js'

describe('responsesToChatMessages 输入映射', () => {
  it('string input → 单条 user 消息', () => {
    const messages = responsesToChatMessages({ model: 'm', input: '你好' })
    expect(messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('instructions 存在 → 前置 system 消息，随后是 input', () => {
    const messages = responsesToChatMessages({ model: 'm', instructions: '你是助手', input: '你好' })
    expect(messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ])
  })

  it('空/缺失 instructions 与 input → 不产出消息', () => {
    expect(responsesToChatMessages({ model: 'm' })).toEqual([])
    expect(responsesToChatMessages({ model: 'm', instructions: '', input: undefined })).toEqual([])
  })

  it('数组 input：{role, content} 直接透传，{type:message} 取 role/content', () => {
    const messages = responsesToChatMessages({
      model: 'm',
      input: [
        { role: 'user', content: '你好' },
        { type: 'message', role: 'assistant', content: '收到' },
      ],
    })
    expect(messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '收到' },
    ])
  })

  it('数组 input：function_call 等无 role 项忽略，其余项保留', () => {
    const messages = responsesToChatMessages({
      model: 'm',
      input: [
        { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: '晴' },
        { role: 'user', content: '继续' },
      ],
    })
    expect(messages).toEqual([{ role: 'user', content: '继续' }])
  })

  it('多模态 content：input_text/output_text 片段按换行拼接文本', () => {
    const messages = responsesToChatMessages({
      model: 'm',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '第一段' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'output_text', text: '第二段' },
          ],
        },
      ],
    })
    expect(messages).toEqual([{ role: 'user', content: '第一段\n第二段' }])
  })

  it('content 缺失/对象/非字符串数组 → 空串兜底', () => {
    const messages = responsesToChatMessages({
      model: 'm',
      input: [
        { role: 'user' },
        { role: 'assistant', content: 42 },
        { role: 'user', content: [{ type: 'input_image', image_url: 'x' }] },
      ],
    })
    expect(messages).toEqual([
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '' },
    ])
  })
})

describe('responsesRequestToChat 整体转换', () => {
  it('max_output_tokens → max_tokens，temperature 透传，stream 缺省 false', () => {
    const chat = responsesRequestToChat({ model: 'm', input: 'hi', max_output_tokens: 100, temperature: 0.7 })
    expect(chat).toMatchObject({ model: 'm', max_tokens: 100, temperature: 0.7, stream: false })
    expect(chat.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('stream: true 透传，白名单字段原样透传', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      stream: true,
      top_p: 0.9,
      stop: ['END'],
      response_format: { type: 'json_object' },
    })
    expect(chat).toMatchObject({ stream: true, top_p: 0.9, stop: ['END'], response_format: { type: 'json_object' } })
  })

  it('responses 专属字段（include 等）不透传', () => {
    const chat = responsesRequestToChat({ model: 'm', input: 'hi', include: ['usage'] })
    expect('include' in chat).toBe(false)
  })

  it('绝不修改入参对象', () => {
    const input = {
      model: 'm',
      instructions: '你是助手',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 50,
      temperature: 0.3,
    }
    const snapshot = structuredClone(input)
    responsesRequestToChat(input)
    expect(input).toEqual(snapshot)
  })
})

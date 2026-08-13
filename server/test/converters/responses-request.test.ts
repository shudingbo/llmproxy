// Responses → Chat 请求转换器测试
// 覆盖：string input、数组 input、instructions 前置、多模态 content 文本提取、
// max_output_tokens 映射、参数透传、入参不可变、不可映射项忽略
import { describe, expect, it } from 'vitest'
import { responsesRequestToChat, responsesToChatMessages } from '../../src/converters/responses-request.js'

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

  it('tools：扁平 function 包装为嵌套，工具顺序保持不变', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object' } },
        { type: 'function', name: 'get_stock', description: '查股价', parameters: { type: 'object' } },
      ],
    })
    expect(chat.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'get_stock', description: '查股价', parameters: { type: 'object' } } },
    ])
    // 顺序保持：第二个工具仍是 get_stock（未被排序/重排）
    expect((chat.tools as Array<{ function: { name: string } }>)[1].function.name).toBe('get_stock')
  })

  it('tools：function 工具内部字段顺序保持，strict 等扩展字段一并收进 function', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tools: [
        { type: 'function', name: 'fn', description: 'd', parameters: { type: 'object' }, strict: true },
      ],
    })
    // 除 type 外其余字段按原顺序收进 function（Object.keys 顺序验证）
    const tool = (chat.tools as Array<{ function: Record<string, unknown> }>)[0]
    expect(Object.keys(tool.function)).toEqual(['name', 'description', 'parameters', 'strict'])
  })

  it('tools：非 function 类型（custom/web_search）原样保留、位置不变', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tools: [
        { type: 'custom', id: 'c1' },
        { type: 'function', name: 'fn1', description: 'd' },
        { type: 'web_search', max_results: 5 },
      ],
    })
    expect(chat.tools).toEqual([
      { type: 'custom', id: 'c1' },
      { type: 'function', function: { name: 'fn1', description: 'd' } },
      { type: 'web_search', max_results: 5 },
    ])
  })

  it('tools 缺失/空数组 → 不注入 tools 字段', () => {
    expect('tools' in responsesRequestToChat({ model: 'm', input: 'hi' })).toBe(false)
    expect('tools' in responsesRequestToChat({ model: 'm', input: 'hi', tools: [] })).toBe(false)
  })

  it('tool_choice：{type:function, name} 包装为嵌套，字符串形式原样透传', () => {
    const obj = responsesRequestToChat({ model: 'm', input: 'hi', tool_choice: { type: 'function', name: 'get_weather' } })
    expect(obj.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
    expect(responsesRequestToChat({ model: 'm', input: 'hi', tool_choice: 'auto' }).tool_choice).toBe('auto')
    expect(responsesRequestToChat({ model: 'm', input: 'hi', tool_choice: 'none' }).tool_choice).toBe('none')
  })

  it('输出字段顺序固定：model → messages → stream → tools → tool_choice → max_tokens → 白名单', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tools: [{ type: 'function', name: 'fn1' }],
      tool_choice: { type: 'function', name: 'fn1' },
      max_output_tokens: 10,
      temperature: 0.5,
      seed: 7,
      top_p: 0.9,
      stop: ['END'],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      response_format: { type: 'json_object' },
    })
    expect(Object.keys(chat)).toEqual([
      'model',
      'messages',
      'stream',
      'tools',
      'tool_choice',
      'max_tokens',
      'temperature',
      'top_p',
      'stop',
      'seed',
      'presence_penalty',
      'frequency_penalty',
      'response_format',
    ])
  })

  it('绝不修改入参对象', () => {
    const input = {
      model: 'm',
      instructions: '你是助手',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 50,
      temperature: 0.3,
      tools: [{ type: 'function', name: 'fn1', description: 'd', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'fn1' },
    }
    const snapshot = structuredClone(input)
    responsesRequestToChat(input)
    expect(input).toEqual(snapshot)
  })
})

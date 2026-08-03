// OpenAI → Ollama 聊天请求转换器测试（T13）
// 覆盖：最小输入、入参不可变、多模态图片、tools 丢弃、response_format 映射、采样参数、stream 透传、消息附加字段丢弃
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLogger } from '../../src/logger/index.js'
import { convertChatRequest, type OpenAIChatRequest } from '../../src/converters/openai-to-ollama-request.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('convertChatRequest 基础映射', () => {
  it('最小输入：仅 model 与一条消息 → stream: false', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result).toEqual({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
  })

  it('绝不修改入参对象', () => {
    const input: OpenAIChatRequest = {
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      response_format: { type: 'json_object' },
      tools: [{ type: 'function' }],
    }
    const snapshot = structuredClone(input)
    convertChatRequest(input)
    expect(input).toEqual(snapshot)
  })
})

describe('多模态内容', () => {
  it('数组内容：文本按换行拼接，data: 图片剥离前缀进 images', () => {
    const result = convertChatRequest({
      model: 'llama3.2-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: '再描述' },
          ],
        },
      ],
    })
    expect(result.messages).toEqual([{ role: 'user', content: '看图\n再描述' }])
    expect(result.images).toEqual(['AAAA'])
  })

  it('非 data: 前缀的图片 URL 原样透传', () => {
    const result = convertChatRequest({
      model: 'llama3.2-vision',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
        },
      ],
    })
    expect(result.messages).toEqual([{ role: 'user', content: '' }])
    expect(result.images).toEqual(['https://example.com/a.png'])
  })

  it('重复图片去重，仅保留首次出现的值', () => {
    const result = convertChatRequest({
      model: 'llama3.2-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
          ],
        },
      ],
    })
    expect(result.images).toEqual(['AAA', 'BBB'])
  })
})

describe('tools 与消息附加字段', () => {
  it('请求级 tools 丢弃：不输出 tools/images，记 info 不记 warn', () => {
    const infoSpy = vi.spyOn(getLogger(), 'info').mockImplementation(() => true)
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    expect(result).not.toHaveProperty('tools')
    expect(result).not.toHaveProperty('images')
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('消息中的 name/tool_calls/tool_call_id/function_call 丢弃，role/content 保留，tool_calls 记 warn', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const result = convertChatRequest({
      model: 'llama3',
      messages: [
        {
          role: 'assistant',
          content: '结果如下',
          name: 'assistant-name',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          tool_call_id: 'call_1',
          function_call: { name: 'f', arguments: '{}' },
        },
      ],
    })
    expect(result.messages).toEqual([{ role: 'assistant', content: '结果如下' }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('response_format 映射', () => {
  it("{ type: 'json_object' } → format: 'json'", () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    })
    expect(result.format).toBe('json')
  })

  it('json_schema → format 透传 json_schema 对象', () => {
    const schema = {
      name: 'weather',
      strict: true,
      schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: schema },
    })
    expect(result.format).toEqual(schema)
  })

  it('response_format 缺省 → 不输出 format 字段', () => {
    const result = convertChatRequest({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] })
    expect(result).not.toHaveProperty('format')
  })
})

describe('采样参数映射', () => {
  it('temperature/top_p/stop/seed → options 透传', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      stop: ['\n'],
      seed: 42,
    })
    expect(result.options).toEqual({ temperature: 0.7, top_p: 0.9, stop: ['\n'], seed: 42 })
  })

  it('stop 为单个字符串时归一化为数组', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stop: '\n',
    })
    expect(result.options).toEqual({ stop: ['\n'] })
  })

  it('max_tokens → options.num_predict', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(result.options).toEqual({ num_predict: 100 })
  })

  it('presence_penalty / frequency_penalty 静默丢弃（Ollama 无对应参数）', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      presence_penalty: 1.0,
      frequency_penalty: 0.5,
    })
    expect(result).not.toHaveProperty('options')
  })
})

describe('stream 透传', () => {
  it('stream: true → stream: true', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(result.stream).toBe(true)
  })

  it('stream: false → stream: false', () => {
    const result = convertChatRequest({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(result.stream).toBe(false)
  })
})

// 模式测试：默认值补齐、非法字段拒绝
import { describe, expect, it } from 'vitest'
import { ConfigSchema, UpstreamSchema } from './schema.js'

// 一份完整合法的配置样本（各测试复用）
const validConfig = {
  upstreams: [
    {
      id: 'openai-main',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      timeoutMs: 60000,
      disabled: false,
    },
  ],
  downstreamModels: {
    'gpt-4': [{ upstreamId: 'openai-main', model: 'gpt-4' }],
  },
}

describe('ConfigSchema', () => {
  it('合法配置解析成功，且缺省字段自动补齐', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    // timeoutMs / disabled 显式给出时原样保留
    expect(result.data.upstreams[0].timeoutMs).toBe(60000)
    expect(result.data.upstreams[0].disabled).toBe(false)
  })

  it('缺省字段应用默认值（timeoutMs 30000、disabled false）', () => {
    const result = ConfigSchema.safeParse({
      upstreams: [{ id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }],
      downstreamModels: { 'm1': [{ upstreamId: 'a', model: 'm1' }] },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.upstreams[0].timeoutMs).toBe(30000)
    expect(result.data.upstreams[0].disabled).toBe(false)
  })

  it('upstreams 为空数组时拒绝', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, upstreams: [] })
    expect(result.success).toBe(false)
  })

  it('downstreamModels 为空对象时仍接受（z.record 无长度约束）', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, downstreamModels: {} })
    expect(result.success).toBe(true)
  })

  it('候选列表为空数组时拒绝（min(1)）', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      downstreamModels: { 'gpt-4': [] },
    })
    expect(result.success).toBe(false)
  })
})

describe('UpstreamSchema', () => {
  it('id 为空串时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: '', baseUrl: 'https://x.example', apiKey: 'k' }).success).toBe(false)
  })

  it('baseUrl 非合法 URL 时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: 'a', baseUrl: 'not-a-url', apiKey: 'k' }).success).toBe(false)
  })

  it('apiKey 为空串时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: 'a', baseUrl: 'https://x.example', apiKey: '' }).success).toBe(false)
  })

  it('timeoutMs 非正整数时拒绝（负数 / 小数 / 字符串）', () => {
    const base = { id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: -1 }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: 1.5 }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: '30000' }).success).toBe(false)
  })
})

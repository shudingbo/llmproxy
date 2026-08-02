// 管理端辅助函数单元测试：maskApiKey 掩码规则与 scrubSensitiveKeys 递归清洗
import { describe, expect, it } from 'vitest'
import { maskApiKey, scrubSensitiveKeys } from './admin-helpers.js'

describe('maskApiKey', () => {
  it('长密钥保留后 4 位并加 3 星前缀', () => {
    expect(maskApiKey('sk-test-1234')).toBe('***1234')
  })

  it('超过 4 位即视为长密钥（5 位也只暴露后 4 位）', () => {
    expect(maskApiKey('abcde')).toBe('***bcde')
  })

  it('短密钥（≤4 位）整段用 * 填充，不泄露任何字符', () => {
    expect(maskApiKey('ab')).toBe('**')
    expect(maskApiKey('abcd')).toBe('****')
    expect(maskApiKey('')).toBe('')
  })
})

describe('scrubSensitiveKeys', () => {
  it('深度清洗全部敏感键并保留数组结构', () => {
    const input = {
      name: 'keep',
      authorization: 'Bearer tok',
      nested: { api_key: 's1', apikey: 's2', ok: { 'x-api-key': 's3', keep: 1 } },
      list: [{ 'x-api-key': 's4', keep: 2 }, 'plain'],
    }
    expect(scrubSensitiveKeys(input)).toEqual({
      name: 'keep',
      authorization: '[REDACTED]',
      nested: { api_key: '[REDACTED]', apikey: '[REDACTED]', ok: { 'x-api-key': '[REDACTED]', keep: 1 } },
      list: [{ 'x-api-key': '[REDACTED]', keep: 2 }, 'plain'],
    })
  })

  it('键名匹配大小写不敏感', () => {
    expect(scrubSensitiveKeys({ Authorization: 'a', API_KEY: 'b', 'X-API-KEY': 'c' })).toEqual({
      Authorization: '[REDACTED]',
      API_KEY: '[REDACTED]',
      'X-API-KEY': '[REDACTED]',
    })
  })

  it('返回深拷贝，不修改原对象', () => {
    const input = { authorization: 'tok', keep: { v: 1 } }
    const out = scrubSensitiveKeys(input)
    expect(out).not.toBe(input)
    expect((out as { keep: unknown }).keep).not.toBe(input.keep)
    expect(input.authorization).toBe('tok')
  })

  it('标量值原样返回', () => {
    expect(scrubSensitiveKeys('plain')).toBe('plain')
    expect(scrubSensitiveKeys(42)).toBe(42)
    expect(scrubSensitiveKeys(null)).toBe(null)
    expect(scrubSensitiveKeys(undefined)).toBe(undefined)
  })
})

// 加载器测试：合法 JSONC 解析、语法错误、模式违规（含字段路径）、旧"裸数组"形态向后兼容
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfigFromFile } from '../../src/config/loader.js'

// 旧形态：downstreamModels 别名 → [ ...candidates ]（裸数组，向后兼容）
const legacySampleJsonc = `{
  // 上游列表
  "upstreams": [
    {
      "id": "openai-main",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-test",
      "timeoutMs": 60000,
      "disabled": false,
    },
  ],
  "downstreamModels": {
    "gpt-4": [
      { "upstreamId": "openai-main", "model": "gpt-4" },
    ],
  },
}
`

// 新形态：downstreamModels 别名 → { disabled?, candidates: [...] }
const newShapeSampleJsonc = `{
  "upstreams": [
    {
      "id": "openai-main",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-test",
      "timeoutMs": 60000,
      "disabled": false,
    },
  ],
  "downstreamModels": {
    "gpt-4": {
      "disabled": false,
      "candidates": [
        { "upstreamId": "openai-main", "model": "gpt-4" }
      ]
    },
    "off-alias": {
      "disabled": true,
      "candidates": [
        { "upstreamId": "openai-main", "model": "gpt-4" }
      ]
    }
  }
}
`

describe('loadConfigFromFile', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmproxy-loader-'))
    path = join(dir, 'config.jsonc')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('解析旧"裸数组"形态的 JSONC，并归一化为 group 形态', () => {
    writeFileSync(path, legacySampleJsonc, 'utf-8')
    const config = loadConfigFromFile(path)
    expect(config.upstreams).toHaveLength(1)
    expect(config.upstreams[0].id).toBe('openai-main')
    expect(config.upstreams[0].timeoutMs).toBe(60000)
    // 旧数组形态被自动包成 group；候选级 disabled 已移除（schema strip 多余键）
    expect(config.downstreamModels['gpt-4']).toEqual({
      disabled: false,
      candidates: [{ upstreamId: 'openai-main', model: 'gpt-4' }],
    })
  })

  it('解析新 group 形态的 JSONC（显式 disabled 字段）', () => {
    writeFileSync(path, newShapeSampleJsonc, 'utf-8')
    const config = loadConfigFromFile(path)
    expect(config.downstreamModels['gpt-4']).toEqual({
      disabled: false,
      candidates: [{ upstreamId: 'openai-main', model: 'gpt-4' }],
    })
    expect(config.downstreamModels['off-alias']).toEqual({
      disabled: true,
      candidates: [{ upstreamId: 'openai-main', model: 'gpt-4' }],
    })
  })

  it('省略可选字段时应用默认值', () => {
    writeFileSync(
      path,
      JSON.stringify({
        upstreams: [{ id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }],
        downstreamModels: { 'm': [{ upstreamId: 'a', model: 'm' }] },
      }),
      'utf-8',
    )
    const config = loadConfigFromFile(path)
    expect(config.upstreams[0].timeoutMs).toBe(30000)
    expect(config.upstreams[0].disabled).toBe(false)
    // 旧数组形态归一化后 disabled 缺省 false
    expect(config.downstreamModels['m'].disabled).toBe(false)
  })

  it('文件不存在时抛出 PARSE 错误且带路径', () => {
    const missing = join(dir, 'missing.jsonc')
    let caught: unknown
    try {
      loadConfigFromFile(missing)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const e = caught as ConfigError
    expect(e.code).toBe('PARSE')
    expect(e.path).toBe(missing)
  })

  it('JSONC 语法错误时抛出 PARSE 错误', () => {
    writeFileSync(path, '{ "upstreams": [', 'utf-8')
    let caught: unknown
    try {
      loadConfigFromFile(path)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe('PARSE')
  })

  it('模式违规时抛出 VALIDATE 错误且 message 含字段路径', () => {
    writeFileSync(
      path,
      JSON.stringify({
        upstreams: [{ id: 'a', baseUrl: 'not-a-url', apiKey: 'k' }],
        downstreamModels: { 'm': [{ upstreamId: 'a', model: 'm' }] },
      }),
      'utf-8',
    )
    let caught: unknown
    try {
      loadConfigFromFile(path)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const e = caught as ConfigError
    expect(e.code).toBe('VALIDATE')
    expect(e.message).toContain('upstreams.0.baseUrl')
  })
})

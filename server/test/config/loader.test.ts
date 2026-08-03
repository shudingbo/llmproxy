// 加载器测试：合法 JSONC 解析、语法错误、模式违规（含字段路径）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfigFromFile } from '../../src/config/loader.js'

// 带注释与尾逗号的合法 JSONC 样本
const sampleJsonc = `{
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

  it('解析带注释与尾逗号的 JSONC，并补齐缺省字段', () => {
    writeFileSync(path, sampleJsonc, 'utf-8')
    const config = loadConfigFromFile(path)
    expect(config.upstreams).toHaveLength(1)
    expect(config.upstreams[0].id).toBe('openai-main')
    expect(config.upstreams[0].timeoutMs).toBe(60000)
    expect(config.downstreamModels['gpt-4']).toEqual([{ upstreamId: 'openai-main', model: 'gpt-4' }])
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

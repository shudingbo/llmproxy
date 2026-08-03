// 路由解析测试：候选映射、禁用过滤、全部禁用告警、未知名抛错、空值/非法入参
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { getLogger } from '../../src/logger/index.js'
import { ModelNotFoundError } from '../../src/router/errors.js'
import { Router } from '../../src/router/index.js'

// 含 4 个下游模型、3 个上游的配置样本：
// - gpt-4 → 2 个候选（openai-main / openai-backup，均活跃）
// - mixed → 2 个候选（openai-paused 禁用 / openai-main 活跃）
// - paused → 1 个候选（openai-paused 禁用）
// - llama3 → 1 个候选（openai-main 活跃）
function buildConfig(): Config {
  return {
    upstreams: [
      { id: 'openai-main', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-a', timeoutMs: 30000, disabled: false },
      { id: 'openai-backup', baseUrl: 'https://api.backup.com/v1', apiKey: 'sk-b', timeoutMs: 30000, disabled: false },
      { id: 'openai-paused', baseUrl: 'https://api.paused.com/v1', apiKey: 'sk-c', timeoutMs: 30000, disabled: true },
    ],
    downstreamModels: {
      'gpt-4': [
        { upstreamId: 'openai-main', model: 'gpt-4' },
        { upstreamId: 'openai-backup', model: 'gpt-4-backup' },
      ],
      'mixed': [
        { upstreamId: 'openai-paused', model: 'gpt-4' },
        { upstreamId: 'openai-main', model: 'gpt-4' },
      ],
      'paused': [{ upstreamId: 'openai-paused', model: 'gpt-4' }],
      'llama3': [{ upstreamId: 'openai-main', model: 'llama3' }],
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Router.resolve', () => {
  it('多候选模型返回全部活跃候选，且保持配置顺序', () => {
    const router = new Router(buildConfig())
    expect(router.resolve('gpt-4')).toEqual([
      { upstreamId: 'openai-main', model: 'gpt-4' },
      { upstreamId: 'openai-backup', model: 'gpt-4-backup' },
    ])
  })

  it('部分候选禁用时只过滤被禁用的，其余保持顺序返回且不告警', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const router = new Router(buildConfig())
    expect(router.resolve('mixed')).toEqual([{ upstreamId: 'openai-main', model: 'gpt-4' }])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('唯一候选被禁用（全部过滤）时记警告并返回原列表', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const router = new Router(buildConfig())
    expect(router.resolve('paused')).toEqual([{ upstreamId: 'openai-paused', model: 'gpt-4' }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('全部候选禁用（多候选）时同样警告并返回原列表', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const config: Config = {
      upstreams: [
        { id: 'a', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: true },
        { id: 'b', baseUrl: 'https://b.example', apiKey: 'k', timeoutMs: 30000, disabled: true },
      ],
      downstreamModels: {
        'm': [
          { upstreamId: 'a', model: 'm1' },
          { upstreamId: 'b', model: 'm2' },
        ],
      },
    }
    const router = new Router(config)
    expect(router.resolve('m')).toEqual([
      { upstreamId: 'a', model: 'm1' },
      { upstreamId: 'b', model: 'm2' },
    ])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('未知模型抛 ModelNotFoundError', () => {
    const router = new Router(buildConfig())
    try {
      router.resolve('unknown')
      expect.unreachable('应当抛出 ModelNotFoundError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError)
    }
  })

  it('空串模型抛 ModelNotFoundError', () => {
    const router = new Router(buildConfig())
    try {
      router.resolve('')
      expect.unreachable('应当抛出 ModelNotFoundError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError)
    }
  })

  it('null 入参抛 ModelNotFoundError（强转后未匹配任何别名）', () => {
    const router = new Router(buildConfig())
    try {
      router.resolve(null as unknown as string)
      expect.unreachable('应当抛出 ModelNotFoundError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError)
    }
  })
})

// 路由解析测试：别名级总开关 + 上游级 disabled 过滤、未知/空抛错
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { getLogger } from '../../src/logger/index.js'
import { ModelNotFoundError } from '../../src/router/errors.js'
import { Router } from '../../src/router/index.js'

// 默认 4 个别名 / 3 个上游的标准样本（group 形态）：
// - gpt-4 → 2 个候选（openai-main / openai-backup，均活跃、别名开）
// - mixed → 2 个候选（openai-paused 禁用 / openai-main 活跃）
// - paused → 1 个候选（openai-paused 上游级禁用）
// - llama3 → 1 个候选（openai-main 活跃）
function buildConfig(): Config {
  return {
    upstreams: [
      { id: 'openai-main', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-a', timeoutMs: 30000, disabled: false, responsesApi: 'convert' },
      { id: 'openai-backup', baseUrl: 'https://api.backup.com/v1', apiKey: 'sk-b', timeoutMs: 30000, disabled: false, responsesApi: 'convert' },
      { id: 'openai-paused', baseUrl: 'https://api.paused.com/v1', apiKey: 'sk-c', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
    ],
    downstreamModels: {
      'gpt-4': {
        disabled: false,
        candidates: [
          { upstreamId: 'openai-main', model: 'gpt-4' },
          { upstreamId: 'openai-backup', model: 'gpt-4-backup' },
        ],
      },
      'mixed': {
        disabled: false,
        candidates: [
          { upstreamId: 'openai-paused', model: 'gpt-4' },
          { upstreamId: 'openai-main', model: 'gpt-4' },
        ],
      },
      'paused': {
        disabled: false,
        candidates: [{ upstreamId: 'openai-paused', model: 'gpt-4' }],
      },
      'llama3': {
        disabled: false,
        candidates: [{ upstreamId: 'openai-main', model: 'llama3' }],
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Router.resolve（基础行为）', () => {
  it('多候选模型返回全部活跃候选，且保持配置顺序', () => {
    const router = new Router(buildConfig())
    expect(router.resolve('gpt-4')).toEqual([
      { upstreamId: 'openai-main', model: 'gpt-4' },
      { upstreamId: 'openai-backup', model: 'gpt-4-backup' },
    ])
  })

  it('部分候选上游级禁用时只过滤被禁用的，其余保持顺序返回且不告警', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const router = new Router(buildConfig())
    expect(router.resolve('mixed')).toEqual([{ upstreamId: 'openai-main', model: 'gpt-4' }])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('唯一候选上游级禁用（全部过滤）时记警告并返回原列表', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const router = new Router(buildConfig())
    expect(router.resolve('paused')).toEqual([{ upstreamId: 'openai-paused', model: 'gpt-4' }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('上游全部禁用时（多候选）同样警告并返回原候选列表', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const config: Config = {
      upstreams: [
        { id: 'a', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
        { id: 'b', baseUrl: 'https://b.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
      ],
      downstreamModels: {
        'm': {
          disabled: false,
          candidates: [
            { upstreamId: 'a', model: 'm1' },
            { upstreamId: 'b', model: 'm2' },
          ],
        },
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
    expect(() => router.resolve('unknown')).toThrow(ModelNotFoundError)
  })

  it('空串模型抛 ModelNotFoundError', () => {
    const router = new Router(buildConfig())
    expect(() => router.resolve('')).toThrow(ModelNotFoundError)
  })

  it('null 入参抛 ModelNotFoundError', () => {
    const router = new Router(buildConfig())
    expect(() => router.resolve(null as unknown as string)).toThrow(ModelNotFoundError)
  })
})

describe('Router.resolve（别名级总开关）', () => {
  it('总开关 off → resolve 抛 ModelNotFoundError（不论上游状态如何）', () => {
    const config: Config = {
      upstreams: [{ id: 'a', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        'alias-off': {
          disabled: true,
          // 即便候选引用的是健康上游，总开关 off 时仍不可用
          candidates: [
            { upstreamId: 'a', model: 'm-a' },
            { upstreamId: 'a', model: 'm-a2' },
          ],
        },
      },
    }
    const router = new Router(config)
    expect(() => router.resolve('alias-off')).toThrow(ModelNotFoundError)
  })

  it('总开关 on + 上游级关闭的候选 → 跳过该候选并使用其它候选', () => {
    const config: Config = {
      upstreams: [
        { id: 'upA', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
        { id: 'upB', baseUrl: 'https://b.example', apiKey: 'k', timeoutMs: 30000, disabled: false, responsesApi: 'convert' },
      ],
      downstreamModels: {
        'mix': {
          disabled: false,
          candidates: [
            { upstreamId: 'upA', model: 'm-a' }, // 上游关闭 → 过滤
            { upstreamId: 'upB', model: 'm-b' }, // 保留
          ],
        },
      },
    }
    const router = new Router(config)
    expect(router.resolve('mix')).toEqual([{ upstreamId: 'upB', model: 'm-b' }])
  })

  it('总开关 on + 唯一候选上游级关闭 → 记警告并返回原列表', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const config: Config = {
      upstreams: [{ id: 'a', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' }],
      downstreamModels: {
        'only-disabled-up': {
          disabled: false,
          candidates: [{ upstreamId: 'a', model: 'm-a' }],
        },
      },
    }
    const router = new Router(config)
    expect(router.resolve('only-disabled-up')).toEqual([{ upstreamId: 'a', model: 'm-a' }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('总开关显式 false 与字段缺失行为等价', () => {
    const configA: Config = {
      upstreams: [{ id: 'a', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 30000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        a: { disabled: false, candidates: [{ upstreamId: 'a', model: 'm-a' }] },
      },
    }
    const router = new Router(configA)
    expect(router.resolve('a')).toEqual([{ upstreamId: 'a', model: 'm-a' }])
  })
})

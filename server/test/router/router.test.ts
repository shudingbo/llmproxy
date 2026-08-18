// 路由解析测试：别名级总开关 + 上游级 disabled 过滤、未知/空抛错
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { getLogger } from '../../src/logger/index.js'
import { ModelNotFoundError } from '../../src/router/errors.js'
import { Router } from '../../src/router/index.js'

// 默认 4 个别名 / 3 个上游的标准样本（group 形态）：
// - gpt-4 → 2 个候选（openai-main / openai-backup，均活跃、别名开）
// - mixed → 2 个候选（openai-paused 禁用 / openai-main 活跃；按新语义仍可解析）
// - paused → 1 个候选（openai-paused 上游级禁用，唯一候选引用被关上游 → 抛 model_not_found）
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

  it('部分候选上游级禁用时只过滤被禁用的，其余保持顺序返回', () => {
    const debugSpy = vi.spyOn(getLogger(), 'debug').mockImplementation(() => true)
    const router = new Router(buildConfig())
    expect(router.resolve('mixed')).toEqual([{ upstreamId: 'openai-main', model: 'gpt-4' }])
    // 候选仍有健康上游 → 不应打 debug 告警
    expect(debugSpy).not.toHaveBeenCalled()
  })

  it('唯一候选上游级禁用（全部过滤）→ 抛 ModelNotFoundError（与列表语义对齐）', () => {
    const router = new Router(buildConfig())
    // 这种别名不会出现在 /v1/models 中；调用时也应 model_not_found，与列表语义对齐
    expect(() => router.resolve('paused')).toThrow(ModelNotFoundError)
  })

  it('上游全部禁用时（多候选引用两个 disabled 上游）→ 抛 ModelNotFoundError', () => {
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
    expect(() => router.resolve('m')).toThrow(ModelNotFoundError)
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

describe('Router.resolve（别名级总开关 / 上游全关 语义对齐）', () => {
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

  it('总开关 on + 唯一候选上游级关闭 → 抛 ModelNotFoundError（与列表语义对齐）', () => {
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
    expect(() => router.resolve('only-disabled-up')).toThrow(ModelNotFoundError)
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

  it('同一别名多候选中至少有一条引用健康上游 → 仍可解析', () => {
    // 用户场景：qwen3.5-9b 配了多个上游，其中部分被关闭
    const config: Config = {
      upstreams: [
        { id: 'main', baseUrl: 'https://main.example', apiKey: 'k', timeoutMs: 30000, disabled: false, responsesApi: 'convert' },
        { id: 'paused', baseUrl: 'https://paused.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
      ],
      downstreamModels: {
        qwen3: {
          disabled: false,
          candidates: [
            { upstreamId: 'paused', model: 'qwen3.5-9b' },
            { upstreamId: 'main', model: 'qwen3.5-9b' },
          ],
        },
      },
    }
    const router = new Router(config)
    expect(router.resolve('qwen3')).toEqual([{ upstreamId: 'main', model: 'qwen3.5-9b' }])
  })

  it('所有候选引用的上游都被关闭 → 抛 ModelNotFoundError', () => {
    // 用户场景：qwen3.5-9b 仅配一个上游 A，A 被 disabled
    const config: Config = {
      upstreams: [
        { id: 'only-up', baseUrl: 'https://only.example', apiKey: 'k', timeoutMs: 30000, disabled: true, responsesApi: 'convert' },
      ],
      downstreamModels: {
        qwen3: {
          disabled: false,
          candidates: [{ upstreamId: 'only-up', model: 'qwen3.5-9b' }],
        },
      },
    }
    const router = new Router(config)
    expect(() => router.resolve('qwen3')).toThrow(ModelNotFoundError)
  })
})

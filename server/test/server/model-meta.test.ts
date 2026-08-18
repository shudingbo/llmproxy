// 模型 meta 聚合测试：n_ctx 最小值（resolveAliasNctx / buildAliasMetaMap）与
// capabilities 并集（resolveAliasCapabilities），覆盖并集去重、空 / 混合 / 重复等场景
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import {
  buildAliasMetaMap,
  isAliasExposed,
  listExposedAliases,
  resolveAliasCapabilities,
  resolveAliasNctx,
} from '../../src/server/model-meta.js'

// 基础配置模板：u1/u2 两个上游；group 形态的下游映射
function makeConfig(downstreamModels: Config['downstreamModels']): Config {
  return {
    upstreams: [
      { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', timeoutMs: 5000, disabled: false, responsesApi: 'convert' },
      { id: 'u2', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k2', timeoutMs: 5000, disabled: false, responsesApi: 'convert' },
    ],
    downstreamModels,
  }
}

// 帮助函数：构造一个最小生效的别名组（默认开启、单一启用候选）
function groupOf(candidates: Config['downstreamModels'][string]['candidates']): Config['downstreamModels'][string] {
  return { disabled: false, candidates }
}

describe('resolveAliasNctx', () => {
  it('无有效值返回 undefined', () => {
    const config = makeConfig({ a: groupOf([{ upstreamId: 'u1', model: 'm' }]) })
    expect(resolveAliasNctx(config, 'a')).toBeUndefined()
  })

  it('取有限正整数的最小值，忽略未配置候选', () => {
    const config = makeConfig({
      a: {
        disabled: false,
        candidates: [
          { upstreamId: 'u1', model: 'm', max_context_length: 16384 },
          { upstreamId: 'u2', model: 'm' },
        ],
      },
    })
    expect(resolveAliasNctx(config, 'a')).toEqual({ n_ctx: 16384 })
  })

  it('别名级总开关关闭 → 返回 undefined（不参与聚合）', () => {
    const config = makeConfig({
      a: {
        disabled: true,
        candidates: [{ upstreamId: 'u1', model: 'm', max_context_length: 8192 }],
      },
    })
    expect(resolveAliasNctx(config, 'a')).toBeUndefined()
  })
})

describe('resolveAliasCapabilities', () => {
  it('无配置返回 undefined', () => {
    const config = makeConfig({ a: groupOf([{ upstreamId: 'u1', model: 'm' }]) })
    expect(resolveAliasCapabilities(config, 'a')).toBeUndefined()
  })

  it('单候选返回其能力列表', () => {
    const config = makeConfig({
      a: groupOf([{ upstreamId: 'u1', model: 'm', capabilities: ['completion', 'vision'] }]),
    })
    expect(resolveAliasCapabilities(config, 'a')).toEqual(['completion', 'vision'])
  })

  it('多候选按首次出现顺序去重取并集', () => {
    const config = makeConfig({
      a: groupOf([
        { upstreamId: 'u1', model: 'm', capabilities: ['completion', 'vision', 'completion'] },
        { upstreamId: 'u2', model: 'm', capabilities: ['vision', 'embedding'] },
      ]),
    })
    expect(resolveAliasCapabilities(config, 'a')).toEqual(['completion', 'vision', 'embedding'])
  })

  it('空数组候选不贡献能力', () => {
    const config = makeConfig({
      a: groupOf([
        { upstreamId: 'u1', model: 'm', capabilities: [] },
        { upstreamId: 'u2', model: 'm' },
      ]),
    })
    expect(resolveAliasCapabilities(config, 'a')).toBeUndefined()
  })
})

describe('buildAliasMetaMap', () => {
  it('同时聚合 n_ctx 与 capabilities', () => {
    const config = makeConfig({
      a: groupOf([
        { upstreamId: 'u1', model: 'm', max_context_length: 8192, capabilities: ['completion'] },
        { upstreamId: 'u2', model: 'm', capabilities: ['vision'] },
      ]),
    })
    expect(buildAliasMetaMap(config)).toEqual({
      a: { n_ctx: 8192, capabilities: ['completion', 'vision'] },
    })
  })

  it('仅有 capabilities 无 n_ctx 时只输出 capabilities', () => {
    const config = makeConfig({
      a: groupOf([{ upstreamId: 'u1', model: 'm', capabilities: ['completion'] }]),
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { capabilities: ['completion'] } })
  })

  it('仅有 n_ctx 无 capabilities 时只输出 n_ctx（行为与扩展前一致）', () => {
    const config = makeConfig({
      a: groupOf([{ upstreamId: 'u1', model: 'm', max_context_length: 4096 }]),
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { n_ctx: 4096 } })
  })

  it('跨候选重复能力去重，n_ctx 取最小值', () => {
    const config = makeConfig({
      a: groupOf([
        { upstreamId: 'u1', model: 'm', max_context_length: 16384, capabilities: ['completion', 'vision'] },
        { upstreamId: 'u2', model: 'm', max_context_length: 32768, capabilities: ['completion', 'vision'] },
      ]),
    })
    expect(buildAliasMetaMap(config)).toEqual({
      a: { n_ctx: 16384, capabilities: ['completion', 'vision'] },
    })
  })

  it('混合：部分候选未配置 capabilities 时按配置的合并', () => {
    const config = makeConfig({
      a: groupOf([
        { upstreamId: 'u1', model: 'm', capabilities: ['completion'] },
        { upstreamId: 'u2', model: 'm' },
      ]),
      b: groupOf([{ upstreamId: 'u1', model: 'm' }]),
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { capabilities: ['completion'] } })
  })

  it('全部候选无任何有效值时别名不在映射中', () => {
    const config = makeConfig({
      a: groupOf([{ upstreamId: 'u1', model: 'm' }]),
      b: groupOf([{ upstreamId: 'u1', model: 'm', capabilities: [] }]),
    })
    expect(buildAliasMetaMap(config)).toEqual({})
  })

  it('别名级总开关 off → 不参与聚合（不写入映射）', () => {
    const config = makeConfig({
      a: {
        disabled: true,
        candidates: [{ upstreamId: 'u1', model: 'm', max_context_length: 8192 }],
      },
    })
    expect(buildAliasMetaMap(config)).toEqual({})
  })
})

// 别名暴露判定：供 /v1/models、/api/tags、/api/show 共用的列表过滤
describe('isAliasExposed', () => {
  it('别名不存在返回 false', () => {
    const config = makeConfig({ a: groupOf([{ upstreamId: 'u1', model: 'm' }]) })
    expect(isAliasExposed(config, 'unknown')).toBe(false)
  })

  it('别名级总开关 off → false', () => {
    const config: Config = {
      upstreams: [{ id: 'u1', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 5000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        off: {
          disabled: true,
          candidates: [{ upstreamId: 'u1', model: 'm-a' }],
        },
      },
    }
    expect(isAliasExposed(config, 'off')).toBe(false)
  })

  it('总开关 on → true（候选列表任意都不影响）', () => {
    const config: Config = {
      upstreams: [{ id: 'u1', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 5000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        a: {
          disabled: false,
          candidates: [{ upstreamId: 'u1', model: 'm-a' }],
        },
      },
    }
    expect(isAliasExposed(config, 'a')).toBe(true)
  })

  it('上游级 disabled（upstream.disabled=true）不影响暴露判定', () => {
    const config: Config = {
      upstreams: [
        { id: 'u1', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 5000, disabled: true, responsesApi: 'convert' },
      ],
      downstreamModels: { a: groupOf([{ upstreamId: 'u1', model: 'm' }]) },
    }
    // 上游级 disabled 与别名级 / 候选级是两层概念，列表端点只走 alias.disabled
    expect(isAliasExposed(config, 'a')).toBe(true)
  })
})

describe('listExposedAliases（别名级总开关语义）', () => {
  it('按配置插入顺序返回对外暴露的别名', () => {
    const config: Config = {
      upstreams: [{ id: 'u1', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 5000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        on: { disabled: false, candidates: [{ upstreamId: 'u1', model: 'm' }] },
        aliasOff: { disabled: true, candidates: [{ upstreamId: 'u1', model: 'm' }] },
        alsoOn: { disabled: false, candidates: [{ upstreamId: 'u1', model: 'm' }] },
      },
    }
    expect(listExposedAliases(config)).toEqual(['on', 'alsoOn'])
  })

  it('全部别名关闭时返回空数组', () => {
    const config: Config = {
      upstreams: [{ id: 'u1', baseUrl: 'https://a.example', apiKey: 'k', timeoutMs: 5000, disabled: false, responsesApi: 'convert' }],
      downstreamModels: {
        a: { disabled: true, candidates: [{ upstreamId: 'u1', model: 'm' }] },
        b: { disabled: true, candidates: [{ upstreamId: 'u1', model: 'm' }] },
      },
    }
    expect(listExposedAliases(config)).toEqual([])
  })
})

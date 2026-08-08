// 模型 meta 聚合测试：n_ctx 最小值（resolveAliasNctx / buildAliasMetaMap）与
// capabilities 并集（resolveAliasCapabilities），覆盖并集去重、空 / 混合 / 重复等场景
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import {
  buildAliasMetaMap,
  resolveAliasCapabilities,
  resolveAliasNctx,
} from '../../src/server/model-meta.js'

// 基础配置模板：u1/u2 两个上游，下游映射按用例内覆盖
function makeConfig(downstreamModels: Config['downstreamModels']): Config {
  return {
    upstreams: [
      { id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', timeoutMs: 5000, disabled: false, responsesApi: 'convert' },
      { id: 'u2', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k2', timeoutMs: 5000, disabled: false, responsesApi: 'convert' },
    ],
    downstreamModels,
  }
}

describe('resolveAliasNctx', () => {
  it('无有效值返回 undefined', () => {
    const config = makeConfig({ a: [{ upstreamId: 'u1', model: 'm' }] })
    expect(resolveAliasNctx(config, 'a')).toBeUndefined()
  })

  it('取有限正整数的最小值，忽略未配置候选', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', max_context_length: 16384 },
        { upstreamId: 'u2', model: 'm' },
      ],
    })
    expect(resolveAliasNctx(config, 'a')).toEqual({ n_ctx: 16384 })
  })
})

describe('resolveAliasCapabilities', () => {
  it('无配置返回 undefined', () => {
    const config = makeConfig({ a: [{ upstreamId: 'u1', model: 'm' }] })
    expect(resolveAliasCapabilities(config, 'a')).toBeUndefined()
  })

  it('单候选返回其能力列表', () => {
    const config = makeConfig({
      a: [{ upstreamId: 'u1', model: 'm', capabilities: ['completion', 'vision'] }],
    })
    expect(resolveAliasCapabilities(config, 'a')).toEqual(['completion', 'vision'])
  })

  it('多候选按首次出现顺序去重取并集', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', capabilities: ['completion', 'vision', 'completion'] },
        { upstreamId: 'u2', model: 'm', capabilities: ['vision', 'embedding'] },
      ],
    })
    expect(resolveAliasCapabilities(config, 'a')).toEqual(['completion', 'vision', 'embedding'])
  })

  it('空数组候选不贡献能力', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', capabilities: [] },
        { upstreamId: 'u2', model: 'm' },
      ],
    })
    expect(resolveAliasCapabilities(config, 'a')).toBeUndefined()
  })
})

describe('buildAliasMetaMap', () => {
  it('同时聚合 n_ctx 与 capabilities', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', max_context_length: 8192, capabilities: ['completion'] },
        { upstreamId: 'u2', model: 'm', capabilities: ['vision'] },
      ],
    })
    expect(buildAliasMetaMap(config)).toEqual({
      a: { n_ctx: 8192, capabilities: ['completion', 'vision'] },
    })
  })

  it('仅有 capabilities 无 n_ctx 时只输出 capabilities', () => {
    const config = makeConfig({
      a: [{ upstreamId: 'u1', model: 'm', capabilities: ['completion'] }],
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { capabilities: ['completion'] } })
  })

  it('仅有 n_ctx 无 capabilities 时只输出 n_ctx（行为与扩展前一致）', () => {
    const config = makeConfig({
      a: [{ upstreamId: 'u1', model: 'm', max_context_length: 4096 }],
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { n_ctx: 4096 } })
  })

  it('跨候选重复能力去重，n_ctx 取最小值', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', max_context_length: 16384, capabilities: ['completion', 'vision'] },
        { upstreamId: 'u2', model: 'm', max_context_length: 32768, capabilities: ['completion', 'vision'] },
      ],
    })
    expect(buildAliasMetaMap(config)).toEqual({
      a: { n_ctx: 16384, capabilities: ['completion', 'vision'] },
    })
  })

  it('混合：部分候选未配置 capabilities 时按配置的合并', () => {
    const config = makeConfig({
      a: [
        { upstreamId: 'u1', model: 'm', capabilities: ['completion'] },
        { upstreamId: 'u2', model: 'm' },
      ],
      b: [{ upstreamId: 'u1', model: 'm' }],
    })
    expect(buildAliasMetaMap(config)).toEqual({ a: { capabilities: ['completion'] } })
  })

  it('全部候选无任何有效值时别名不在映射中', () => {
    const config = makeConfig({
      a: [{ upstreamId: 'u1', model: 'm' }],
      b: [{ upstreamId: 'u1', model: 'm', capabilities: [] }],
    })
    expect(buildAliasMetaMap(config)).toEqual({})
  })
})

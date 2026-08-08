// OpenAI → Ollama 模型列表转换器测试
import { describe, expect, it } from 'vitest'
import { convertModelsList } from '../../src/converters/openai-to-ollama-models.js'

describe('convertModelsList', () => {
  it('单个模型映射为对应的 Ollama 条目', () => {
    const result = convertModelsList({ data: [{ id: 'gpt-4', object: 'model' }] })
    expect(result).toEqual({
      models: [
        {
          name: 'gpt-4',
          model: 'gpt-4',
          modified_at: '2026-01-01T00:00:00Z',
          size: 0,
          details: {
            format: 'openai',
            family: 'openai',
          },
        },
      ],
    })
  })

  it('空 data 返回空模型列表', () => {
    const result = convertModelsList({ data: [] })
    expect(result).toEqual({ models: [] })
  })

  it('多个模型按原顺序映射为多个条目', () => {
    const result = convertModelsList({
      data: [
        { id: 'gpt-4o', object: 'model' },
        { id: 'gpt-4o-mini', object: 'model' },
      ],
    })
    expect(result.models.map((m) => m.name)).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(result.models).toHaveLength(2)
  })

  it('传入 metaById 且命中时条目附加 meta 字段', () => {
    const result = convertModelsList({ data: [{ id: 'gpt-4', object: 'model' }] }, { 'gpt-4': { n_ctx: 8192 } })
    expect(result).toEqual({
      models: [
        {
          name: 'gpt-4',
          model: 'gpt-4',
          modified_at: '2026-01-01T00:00:00Z',
          size: 0,
          details: {
            format: 'openai',
            family: 'openai',
          },
          meta: { n_ctx: 8192 },
        },
      ],
    })
  })

  it('传入 metaById 但未命中时条目不带 meta 字段', () => {
    const result = convertModelsList({ data: [{ id: 'gpt-4', object: 'model' }] }, { 'other-alias': { n_ctx: 4096 } })
    expect(result).toEqual({
      models: [
        {
          name: 'gpt-4',
          model: 'gpt-4',
          modified_at: '2026-01-01T00:00:00Z',
          size: 0,
          details: {
            format: 'openai',
            family: 'openai',
          },
        },
      ],
    })
  })

  it('不传 metaById 时条目不带 meta 字段（与原有行为一致）', () => {
    const result = convertModelsList({ data: [{ id: 'gpt-4', object: 'model' }] })
    expect(result.models[0]).not.toHaveProperty('meta')
  })

  it('传入 metaById 且带 capabilities 时条目附加 capabilities 字段（与 meta 并存）', () => {
    const result = convertModelsList(
      { data: [{ id: 'gpt-4', object: 'model' }] },
      { 'gpt-4': { n_ctx: 8192, capabilities: ['completion', 'vision'] } },
    )
    expect(result.models[0]).toMatchObject({
      meta: { n_ctx: 8192 },
      capabilities: ['completion', 'vision'],
    })
  })

  it('metaById 中 capabilities 为空数组时条目不带 capabilities 字段', () => {
    const result = convertModelsList(
      { data: [{ id: 'gpt-4', object: 'model' }] },
      { 'gpt-4': { capabilities: [] } },
    )
    expect(result.models[0]).not.toHaveProperty('capabilities')
    expect(result.models[0]).not.toHaveProperty('meta')
  })

  it('metaById 中仅含 capabilities 无 n_ctx 时条目带 capabilities 但不带 meta', () => {
    const result = convertModelsList(
      { data: [{ id: 'gpt-4', object: 'model' }] },
      { 'gpt-4': { capabilities: ['completion'] } },
    )
    expect(result.models[0]).toMatchObject({ capabilities: ['completion'] })
    expect(result.models[0]).not.toHaveProperty('meta')
  })

  it('metaById 中 capabilities 未定义时条目不带 capabilities 字段（n_ctx 行为不变）', () => {
    const result = convertModelsList({ data: [{ id: 'gpt-4', object: 'model' }] }, { 'gpt-4': { n_ctx: 8192 } })
    expect(result.models[0]).toMatchObject({ meta: { n_ctx: 8192 } })
    expect(result.models[0]).not.toHaveProperty('capabilities')
  })
})

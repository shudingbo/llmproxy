// OpenAI → Ollama 模型列表转换器测试
import { describe, expect, it } from 'vitest'
import { convertModelsList } from './openai-to-ollama-models.js'

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
})

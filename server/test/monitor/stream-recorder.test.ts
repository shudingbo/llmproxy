// AssistantStreamRecorder 单元测试：chat / responses 两种 SSE 口径的 delta 解析与累积
// 覆盖：跨 chunk 行切分、[DONE] / 注释行 / 非 JSON 行忽略、null delta 跳过、responses done 兜底、finish 幂等
import { describe, expect, it } from 'vitest'
import { AssistantStreamRecorder } from '../../src/monitor/stream-recorder.js'

// 收集 delta 回调
const collect = () => {
  const deltas: string[] = []
  return {
    deltas,
    onDelta: (d: string) => deltas.push(d),
  }
}

describe('AssistantStreamRecorder (chat 口径)', () => {
  it('单 chunk 多条 data 行：逐条回调 delta 并累积完整文本', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed(
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
        'data: [DONE]\n\n',
    )
    expect(deltas).toEqual(['你', '好'])
    expect(r.getContent()).toBe('你好')
  })

  it('单条 SSE 行跨多个 chunk：buffer 累积后完整解析', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed('data: {"choices":[{')
    r.feed('"delta":{"con')
    r.feed('tent":"hello"}}]}\n\n')
    expect(deltas).toEqual(['hello'])
    expect(r.getContent()).toBe('hello')
  })

  it('忽略 event: 行 / 注释行 / 空行 / 非 JSON data 行 / [DONE]', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed(
      'event: message\n' +
        ': keep-alive\n' +
        '\n' +
        'data: not-json\n' +
        'data: [DONE]\n' +
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    )
    expect(deltas).toEqual(['ok'])
  })

  it('delta.content 为 null / 缺失 / 非字符串：跳过', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed(
      'data: {"choices":[{"delta":{}}]}\n' +
        'data: {"choices":[{"delta":{"content":null}}]}\n' +
        'data: {"choices":[{"delta":{"content":42}}]}\n' +
        'data: {"choices":[]}\n' +
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    )
    expect(deltas).toEqual(['x'])
  })

  it('choices 多元素：只取首 choice（n>1 场景不串扰）', () => {
    const { onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed('data: {"choices":[{"delta":{"content":"A"}},{"delta":{"content":"B"}}]}\n\n')
    expect(r.getContent()).toBe('A')
  })
})

describe('AssistantStreamRecorder (responses 口径)', () => {
  it('response.output_text.delta 事件：逐条回调并累积', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('responses', onDelta)
    r.feed(
      'data: {"type":"response.created"}\n\n' +
        'data: {"type":"response.output_text.delta","item_id":"m1","delta":"Hel"}\n\n' +
        'data: {"type":"response.output_text.delta","item_id":"m1","delta":"lo"}\n\n' +
        'data: {"type":"response.completed"}\n\n',
    )
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(r.getContent()).toBe('Hello')
  })

  it('只发 output_text.done（无 delta）：done 全文兜底', () => {
    const { onDelta } = collect()
    const r = new AssistantStreamRecorder('responses', onDelta)
    r.feed('data: {"type":"response.output_text.done","item_id":"m1","text":"完整文本"}\n\n')
    expect(r.getContent()).toBe('完整文本')
  })

  it('delta 与 done 并存：以 delta 累加为准（done 全文不覆盖）', () => {
    const { onDelta } = collect()
    const r = new AssistantStreamRecorder('responses', onDelta)
    r.feed('data: {"type":"response.output_text.delta","item_id":"m1","delta":"AB"}\n\n')
    r.feed('data: {"type":"response.output_text.done","item_id":"m1","text":"不同"}\n\n')
    expect(r.getContent()).toBe('AB')
  })

  it('delta 为 null / 非字符串：跳过', () => {
    const { onDelta } = collect()
    const r = new AssistantStreamRecorder('responses', onDelta)
    r.feed(
      'data: {"type":"response.output_text.delta","item_id":"m1","delta":null}\n\n' +
        'data: {"type":"response.output_text.delta","item_id":"m1","delta":"ok"}\n\n',
    )
    expect(r.getContent()).toBe('ok')
  })
})

describe('finish 语义', () => {
  it('finish 后 feed 为 no-op（不再解析与回调）', () => {
    const { deltas, onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.finish()
    r.feed('data: {"choices":[{"delta":{"content":"late"}}]}\n\n')
    expect(deltas).toEqual([])
    expect(r.isFinished()).toBe(true)
  })

  it('finish 幂等：重复调用无副作用', () => {
    const { onDelta } = collect()
    const r = new AssistantStreamRecorder('chat', onDelta)
    r.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    r.finish()
    expect(() => r.finish()).not.toThrow()
    expect(r.getContent()).toBe('x')
  })
})

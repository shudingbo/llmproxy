// createResponsesStream 单元测试：上游 chat SSE → Responses SSE 事件流转换
// 覆盖：事件序列顺序、delta 拼接、usage 注入、空输出、非 data: 行忽略、上游错误
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { Readable as ReadableType, Writable } from 'node:stream'
import { getLogger } from '../logger/index.js'
import { createResponsesStream } from './responses-stream.js'

// 解析后的 SSE 事件：{ event, data }
interface ParsedEvent {
  event: string
  data: Record<string, unknown>
}

// 收集流全部输出并解析为事件序列（按 \n\n 分隔）
async function collectEvents(stream: ReadableType): Promise<ParsedEvent[]> {
  let text = ''
  for await (const chunk of stream) {
    text += chunk.toString('utf8')
  }
  const events: ParsedEvent[] = []
  for (const block of text.split('\n\n')) {
    if (block.length === 0) continue
    const lines = block.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? ''
    const dataLine = lines.find((line) => line.startsWith('data: '))
    if (dataLine === undefined) continue
    events.push({ event, data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> })
  }
  return events
}

// 构造一个手动喂数据的上游 Readable
function upstream(): Readable {
  return new Readable({ read() {} })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createResponsesStream 基本事件序列', () => {
  it('3 个内容块 → created → ... → completed，delta 拼接为完整文本', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'qwen3.5-9b')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"世界"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    // 事件名序列对齐 Responses API 流式契约
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    // opening 事件：in_progress 状态 + 稳定的 resp/msg id
    const created = events[0].data
    expect(created.type).toBe('response.created')
    const createdResponse = created.response as Record<string, unknown>
    expect(createdResponse).toMatchObject({ object: 'response', status: 'in_progress', model: 'qwen3.5-9b' })
    expect(String(createdResponse.id).startsWith('resp_')).toBe(true)
    const msgId = (events[2].data.item as Record<string, unknown>).id as string
    expect(msgId.startsWith('msg_')).toBe(true)
    // delta 事件逐个输出增量
    const deltas = events.slice(4, 7).map((e) => e.data.delta)
    expect(deltas).toEqual(['你', '好', '世界'])
    // 所有 delta 事件引用同一 item_id
    for (const e of events.slice(4, 7)) {
      expect(e.data.item_id).toBe(msgId)
    }
    // 收尾事件：完整文本
    expect(events[7].data.text).toBe('你好世界')
    const donePart = events[8].data.part as Record<string, unknown>
    expect(donePart).toEqual({ type: 'output_text', text: '你好世界', annotations: [] })
    const doneItem = events[9].data.item as Record<string, unknown>
    expect(doneItem).toMatchObject({ type: 'message', role: 'assistant', status: 'completed' })
    // completed 事件：完整响应对象
    const completedResponse = events[10].data.response as Record<string, unknown>
    expect(completedResponse).toMatchObject({ object: 'response', status: 'completed', model: 'qwen3.5-9b' })
    const output = (completedResponse.output as Array<Record<string, unknown>>)[0]
    expect(output).toMatchObject({ type: 'message', role: 'assistant', status: 'completed' })
    expect((output.content as Array<Record<string, unknown>>)[0].text).toBe('你好世界')
  })

  it('usage 块 → response.completed 携带 usage（chat 字段名 → responses 字段名）', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
    source.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":9,"total_tokens":24}}\n\n',
    )
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    const last = events[events.length - 1]
    expect(last.event).toBe('response.completed')
    expect((last.data.response as Record<string, unknown>).usage).toEqual({
      input_tokens: 15,
      output_tokens: 9,
      total_tokens: 24,
    })
  })

  it('无 usage → completed 事件省略 usage 字段', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    const last = events[events.length - 1]
    expect('usage' in (last.data.response as Record<string, unknown>)).toBe(false)
  })
})

describe('边界情况', () => {
  it('空流（无任何 delta）→ 仍输出完整事件序列，文本为空串', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.push(null)

    const events = await collectEvents(stream)
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events[4].data.text).toBe('')
    expect((events[5].data.part as Record<string, unknown>).text).toBe('')
  })

  it('单条 data: 事件跨两个 chunk → 缓冲拼接后输出', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    // 第一块：行被截断（无换行符）
    source.push('data: {"choices":[{"delta":{"content":"hel')
    // 第二块：剩余部分 + 事件终止符
    source.push('lo"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    expect(events.filter((e) => e.event === 'response.output_text.delta')).toHaveLength(1)
    expect(events.find((e) => e.event === 'response.output_text.delta')?.data.delta).toBe('hello')
  })

  it('非 data: 行（event: / 注释）忽略，不产生输出', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.push('event: message\n: keep-alive comment\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    expect(events.map((e) => e.event)).not.toContain('message')
    expect(events.filter((e) => e.event === 'response.output_text.delta')).toHaveLength(1)
  })

  it('上游 error 事件 → 输出 error 事件后结束', async () => {
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.emit('error', new Error('ECONNRESET'))

    const events = await collectEvents(stream)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('error')
    expect(events[0].data).toMatchObject({ type: 'error', error: { message: 'ECONNRESET' } })
  })

  it('内容块 JSON 解析失败 → warn + 跳过，后续块仍正常输出', async () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const source = upstream()
    const stream = createResponsesStream(source, 'm')
    source.pipe(stream as unknown as Writable)
    source.push('data: {broken json}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"正常"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const events = await collectEvents(stream)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.anything(), 'responses stream parse chunk error')
    expect(events.filter((e) => e.event === 'response.output_text.delta')).toHaveLength(1)
    expect(events[events.length - 1].event).toBe('response.completed')
  })
})

// createOpenAIToOllamaStream 单元测试（T15）：OpenAI SSE → Ollama NDJSON 流式转换
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { Readable as ReadableType, Writable } from 'node:stream'
import { getLogger } from '../../src/logger/index.js'
import { createOpenAIToOllamaStream } from '../../src/converters/openai-to-ollama-stream.js'

// 收集流全部输出并按 \n 切行（丢弃结尾空串），每行应是独立合法的 JSON
async function collectLines(stream: ReadableType): Promise<string[]> {
  let text = ''
  for await (const chunk of stream) {
    text += chunk.toString('utf8')
  }
  return text.split('\n').filter((line) => line.length > 0)
}

// 构造一个手动喂数据的上游 Readable
function upstream(): Readable {
  return new Readable({ read() {} })
}

// 便捷断言：解析一行 JSON 并返回对象
function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createOpenAIToOllamaStream 基本流式输出', () => {
  it('3 个内容块 → 3 行 done:false + 1 行 done:true（共 4 行，每行可独立 JSON.parse）', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"世界"}}]}\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(4)
    // 每行都是独立合法的 JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // 前 3 行：内容块
    const contents = ['你', '好', '世界']
    for (let i = 0; i < 3; i++) {
      const obj = parseLine(lines[i])
      expect(obj.model).toBe('qwen2.5')
      expect(obj.done).toBe(false)
      expect(typeof obj.created_at).toBe('string')
      expect(obj.message).toEqual({ role: 'assistant', content: contents[i] })
    }
    // 最后 1 行：结束标记
    const last = parseLine(lines[3])
    expect(last.done).toBe(true)
    expect(last.done_reason).toBe('stop')
    expect(last.message).toEqual({ role: 'assistant', content: '' })
  })

  it('单条 data: 事件跨两个 chunk → 缓冲拼接后输出', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    // 第一块：行被截断（无换行符）
    source.push('data: {"choices":[{"delta":{"content":"hel')
    // 第二块：剩余部分 + 事件终止符
    source.push('lo"}}]}\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(2)
    expect(parseLine(lines[0]).message).toEqual({ role: 'assistant', content: 'hello' })
    expect(parseLine(lines[1]).done).toBe(true)
  })

  it('空流 → 只输出一行 done:true（无空内容行）', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(1)
    expect(parseLine(lines[0])).toMatchObject({ done: true, done_reason: 'stop' })
  })

  it('非 data: 行（event: / 注释）忽略，不产生输出', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('event: message\n: keep-alive comment\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(2)
    expect(parseLine(lines[0]).message).toEqual({ role: 'assistant', content: 'ok' })
    expect(parseLine(lines[1]).done).toBe(true)
  })
})

describe('usage 捕获', () => {
  it('usage 块 → 结束行带 prompt_eval_count / eval_count，其余 usage 字段丢弃', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
    // usage 块无内容：不输出内容行，仅捕获 token
    source.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":9,"total_tokens":24}}\n\n',
    )
    source.push('data: [DONE]\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(2)
    const last = parseLine(lines[1])
    expect(last.done).toBe(true)
    expect(last.done_reason).toBe('stop')
    expect(last.prompt_eval_count).toBe(15)
    expect(last.eval_count).toBe(9)
    // total_tokens 等非目标字段不产出
    expect('total_tokens' in last).toBe(false)
  })

  it('连续两个 usage 块 → 仅最后一次的 token 生效', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":200}}\n\n')
    source.push('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":8}}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(1)
    const last = parseLine(lines[0])
    expect(last.prompt_eval_count).toBe(7)
    expect(last.eval_count).toBe(8)
  })

  it('data: [DONE] 且无 usage → done:true，且不含 token 计数字段', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: [DONE]\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(1)
    const last = parseLine(lines[0])
    expect(last.done).toBe(true)
    expect(last.done_reason).toBe('stop')
    expect('prompt_eval_count' in last).toBe(false)
    expect('eval_count' in last).toBe(false)
  })
})

describe('错误语义', () => {
  it('上游 error 事件 → 输出一行 { error } 后结束', async () => {
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.emit('error', new Error('ECONNRESET'))

    const lines = await collectLines(stream)
    expect(lines).toHaveLength(1)
    expect(parseLine(lines[0])).toEqual({ error: 'ECONNRESET' })
  })

  it('内容块 JSON 解析失败 → warn + 跳过，后续块仍正常输出', async () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => true)
    const source = upstream()
    const stream = createOpenAIToOllamaStream(source, 'qwen2.5')
    // 把上游数据接入转换器（调用方约定：自行 pipe；工厂签名返回 Readable，需收窄为 Writable）
    source.pipe(stream as unknown as Writable)
    source.push('data: {broken json}\n\n')
    source.push('data: {"choices":[{"delta":{"content":"正常"}}]}\n\n')
    source.push('data: [DONE]\n\n')
    source.push(null)

    const lines = await collectLines(stream)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.anything(), 'parse chunk error')
    // 坏块被跳过：只输出 1 行内容 + 1 行结束
    expect(lines).toHaveLength(2)
    expect(parseLine(lines[0]).message).toEqual({ role: 'assistant', content: '正常' })
    expect(parseLine(lines[1]).done).toBe(true)
  })
})

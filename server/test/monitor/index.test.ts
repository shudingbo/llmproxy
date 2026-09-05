// SessionMonitor 门面单元测试：请求侧去重记录与事件推送、流式记录器（delta 推送 / 整条落库 / truncated 标记）、
// 非流式回答记录（chat / responses 形状）、订阅退订与异常摘除
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionMonitor, type MonitorEvent } from '../../src/monitor/index.js'

const makeTempDbPath = (): string => join(tmpdir(), `monitor-facade-${randomBytes(6).toString('hex')}.db`)

const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

const messages = (sessionKey: string, monitor: SessionMonitor): MonitorEvent[] => {
  const events: MonitorEvent[] = []
  const unsubscribe = monitor.subscribe(sessionKey, (e) => events.push(e))
  return { events, unsubscribe }
}

describe('SessionMonitor', () => {
  let dbPath: string
  let monitor: SessionMonitor

  beforeEach(() => {
    dbPath = makeTempDbPath()
    monitor = new SessionMonitor(dbPath)
  })

  afterEach(() => {
    try {
      monitor.close()
    } catch {
      // ignore
    }
    removeDbFiles(dbPath)
  })

  describe('recordRequest', () => {
    it('多轮请求：历史消息去重，只推送新消息', () => {
      const key = 'gpt-4::s1'
      const { events, unsubscribe } = messages(key, monitor)

      // 第 1 轮：system + user
      monitor.recordRequest(key, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
      ])
      // 第 2 轮：重发历史（system/user/assistant）+ 新 user
      monitor.recordRequest(key, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '再见' },
      ])

      unsubscribe()
      const pushed = events.filter((e) => e.type === 'message')
      // 第 1 轮 2 条 + 第 2 轮新增 2 条（assistant 历史与重发历史被去重）
      expect(pushed).toHaveLength(4)
      expect(pushed.map((e) => (e.type === 'message' ? e.content : ''))).toEqual(['sys', '你好', 'hi', '再见'])
      expect(monitor.count(key)).toBe(4)
    })

    it('sessionKey 缺失 / messages 非数组：no-op 不抛错', () => {
      expect(() => monitor.recordRequest(undefined, [{ role: 'user', content: 'x' }])).not.toThrow()
      expect(() => monitor.recordRequest('k', 'not-an-array')).not.toThrow()
      expect(() => monitor.recordRequest('k', null)).not.toThrow()
      expect(monitor.count('k')).toBe(0)
    })

    it('reasoning_content：请求侧思考内容随行落库，message 事件携带 reasoning', () => {
      const key = 'gpt-4::s3'
      const { events, unsubscribe } = messages(key, monitor)
      monitor.recordRequest(key, [
        { role: 'assistant', content: '历史回答', reasoning_content: '历史思考' },
        { role: 'user', content: '新问题' },
      ])
      unsubscribe()
      const rows = monitor.list(key)
      expect(rows[0].reasoning).toBe('历史思考')
      expect(rows[1].reasoning).toBe('')
      const pushed = events.filter((e) => e.type === 'message')
      expect(pushed[0]).toMatchObject({ role: 'assistant', content: '历史回答', reasoning: '历史思考' })
      expect(pushed[1]).toMatchObject({ role: 'user', content: '新问题', reasoning: '' })
    })

    it('reasoning_details：请求侧思考数组（MiniMax reasoning_split 形态）多元素拼接后落库', () => {
      const key = 'gpt-4::s3d'
      const { events, unsubscribe } = messages(key, monitor)
      monitor.recordRequest(key, [
        {
          role: 'assistant',
          content: '历史回答',
          reasoning_details: [{ text: '思考一' }, { text: '思考二' }],
        },
        { role: 'user', content: '新问题' },
      ])
      unsubscribe()
      expect(monitor.list(key)[0].reasoning).toBe('思考一思考二')
      const pushed = events.filter((e) => e.type === 'message')
      expect(pushed[0]).toMatchObject({ role: 'assistant', content: '历史回答', reasoning: '思考一思考二' })
    })

    it('多模态 content 数组 / 缺失 content：归一化为 JSON 字符串 / 空串', () => {
      const key = 'gpt-4::s2'
      monitor.recordRequest(key, [
        { role: 'user', content: [{ type: 'text', text: '看图' }] },
        { role: 'tool', tool_call_id: 't1' },
        { role: '' },
      ])
      const rows = monitor.list(key)
      expect(rows).toHaveLength(2)
      expect(rows[0].content).toBe(JSON.stringify([{ type: 'text', text: '看图' }]))
      // role 空 + content 缺失 → 整条跳过；tool 消息 content 空串仍记录（role 非空）
      expect(rows[1].role).toBe('tool')
      expect(rows[1].content).toBe('')
    })
  })

  describe('createAssistantRecorder', () => {
    it('delta 实时推送 + finish 整条落库（assistant_done 携带完整文本与 finalId）', () => {
      const key = 'gpt-4::s1'
      const { events, unsubscribe } = messages(key, monitor)
      const handle = monitor.createAssistantRecorder(key, 'chat')

      handle.feed('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      handle.feed('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
      handle.finish(false)
      unsubscribe()

      const deltas = events.filter((e) => e.type === 'assistant_delta')
      expect(deltas.map((e) => (e.type === 'assistant_delta' ? e.content : ''))).toEqual(['你', '好'])

      const done = events.find((e) => e.type === 'assistant_done')
      expect(done).toBeDefined()
      if (done !== undefined && done.type === 'assistant_done') {
        expect(done.content).toBe('你好')
        expect(done.finalId).toBeTypeOf('number')
        expect(done.truncated).toBe(false)
      }
      // 落库一条 assistant（delta 不单独落库）
      expect(monitor.count(key)).toBe(1)
      expect(monitor.list(key)[0].role).toBe('assistant')
    })

    it('思考通道：reasoning_content delta 以 channel=think 推送，done 与落库均携带完整思考', () => {
      const key = 'gpt-4::s5'
      const { events, unsubscribe } = messages(key, monitor)
      const handle = monitor.createAssistantRecorder(key, 'chat')
      handle.feed('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n')
      handle.feed('data: {"choices":[{"delta":{"reasoning_content":"了"}}]}\n\n')
      handle.feed('data: {"choices":[{"delta":{"content":"答"}}]}\n\n')
      handle.finish(false)
      unsubscribe()

      const deltas = events.filter((e) => e.type === 'assistant_delta')
      expect(
        deltas.map((e) => (e.type === 'assistant_delta' ? [e.channel, e.content] : null)),
      ).toEqual([
        ['think', '想'],
        ['think', '了'],
        ['content', '答'],
      ])

      const done = events.find((e) => e.type === 'assistant_done')
      expect(done).toBeDefined()
      if (done !== undefined && done.type === 'assistant_done') {
        expect(done.content).toBe('答')
        expect(done.reasoning).toBe('想了')
        expect(done.finalId).toBeTypeOf('number')
      }
      const row = monitor.list(key)[0]
      expect(row).toMatchObject({ role: 'assistant', content: '答', reasoning: '想了' })
    })

    it('仅思考无正文（思考中被中断）：reasoning 非空也落库', () => {
      const key = 'gpt-4::s6'
      const handle = monitor.createAssistantRecorder(key, 'chat')
      handle.feed('data: {"choices":[{"delta":{"reasoning_content":"半"}}]}\n\n')
      handle.finish(true)
      expect(monitor.list(key)).toHaveLength(1)
      expect(monitor.list(key)[0]).toMatchObject({ content: '', reasoning: '半' })
    })

    it('finish(aborted=true)：已收到的部分落库并标记 truncated', () => {
      const key = 'gpt-4::s2'
      const { events, unsubscribe } = messages(key, monitor)
      const handle = monitor.createAssistantRecorder(key, 'chat')
      handle.feed('data: {"choices":[{"delta":{"content":"半"}}]}\n\n')
      handle.finish(true)
      unsubscribe()

      const done = events.find((e) => e.type === 'assistant_done')
      if (done !== undefined && done.type === 'assistant_done') {
        expect(done.content).toBe('半')
        expect(done.truncated).toBe(true)
      }
      expect(monitor.list(key).map((r) => r.content)).toEqual(['半'])
    })

    it('finish 幂等：重复 finish 不重复落库', () => {
      const key = 'gpt-4::s3'
      const handle = monitor.createAssistantRecorder(key, 'chat')
      handle.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
      handle.finish(false)
      handle.finish(true)
      expect(monitor.count(key)).toBe(1)
    })

    it('空回答（无 delta）：finalId 为 null，不落库', () => {
      const key = 'gpt-4::s4'
      const { events, unsubscribe } = messages(key, monitor)
      const handle = monitor.createAssistantRecorder(key, 'chat')
      handle.finish(false)
      unsubscribe()

      const done = events.find((e) => e.type === 'assistant_done')
      if (done !== undefined && done.type === 'assistant_done') {
        expect(done.content).toBe('')
        expect(done.finalId).toBeNull()
      }
      expect(monitor.count(key)).toBe(0)
    })

    it('sessionKey 缺失：返回空实现句柄（feed/finish 零开销 no-op）', () => {
      const handle = monitor.createAssistantRecorder(undefined, 'chat')
      expect(() => {
        handle.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
        handle.finish(false)
      }).not.toThrow()
    })
  })

  describe('非流式回答记录', () => {
    it('recordAssistant：空内容 no-op；正常内容落库 + 推送', () => {
      const key = 'gpt-4::s1'
      monitor.recordAssistant(key, '')
      expect(monitor.count(key)).toBe(0)

      const { events, unsubscribe } = messages(key, monitor)
      monitor.recordAssistant(key, '回答')
      unsubscribe()
      expect(monitor.list(key).map((r) => r.content)).toEqual(['回答'])
      expect(events.some((e) => e.type === 'message' && e.content === '回答')).toBe(true)
    })

    it('recordChatResponse：逐 choice 记录；content 缺失时回退 tool_calls JSON', () => {
      const key = 'gpt-4::s1'
      monitor.recordChatResponse(key, {
        choices: [
          { message: { role: 'assistant', content: '正文' } },
          { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f' } }] } },
        ],
      })
      expect(monitor.list(key).map((r) => r.content)).toEqual([
        '正文',
        JSON.stringify([{ id: 'c1', function: { name: 'f' } }]),
      ])
    })

    it('recordChatResponse：reasoning_content 思考内容随回答落库', () => {
      const key = 'gpt-4::s3'
      const { events, unsubscribe } = messages(key, monitor)
      monitor.recordChatResponse(key, {
        choices: [{ message: { role: 'assistant', content: '回答', reasoning_content: '推理过程' } }],
      })
      unsubscribe()
      expect(monitor.list(key)).toHaveLength(1)
      expect(monitor.list(key)[0]).toMatchObject({ content: '回答', reasoning: '推理过程' })
      expect(events.some((e) => e.type === 'message' && e.reasoning === '推理过程')).toBe(true)
    })

    it('recordChatResponse：reasoning_details 思考数组（MiniMax reasoning_split 形态）拼接后落库；reasoning_content 优先', () => {
      const key = 'gpt-4::s3d'
      const { unsubscribe } = messages(key, monitor)
      monitor.recordChatResponse(key, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '回答',
              reasoning_details: [{ text: '思考一' }, { text: '思考二' }],
            },
          },
        ],
      })
      monitor.recordChatResponse(key, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '回答2',
              reasoning_content: '增量思考',
              reasoning_details: [{ text: '不该被采用' }],
            },
          },
        ],
      })
      unsubscribe()
      expect(monitor.list(key).map((r) => r.reasoning)).toEqual(['思考一思考二', '增量思考'])
    })

    it('recordAssistant：正文空但思考非空 → 落库（思考留痕）', () => {
      const key = 'gpt-4::s7'
      monitor.recordAssistant(key, '')
      expect(monitor.count(key)).toBe(0)
      monitor.recordAssistant(key, '', '只有思考')
      expect(monitor.list(key)).toHaveLength(1)
      expect(monitor.list(key)[0]).toMatchObject({ content: '', reasoning: '只有思考' })
    })

    it('recordChatResponse：形状不符（null / 非对象 / 无 choices）no-op', () => {
      const key = 'gpt-4::s2'
      monitor.recordChatResponse(key, null)
      monitor.recordChatResponse(key, 'str')
      monitor.recordChatResponse(key, { foo: 1 })
      expect(monitor.count(key)).toBe(0)
    })

    it('recordResponsesResponse：提取 message 项文本；前序 reasoning 项 summary 归并到该 message；非 message 项跳过', () => {
      const key = 'gpt-4::s1'
      monitor.recordResponsesResponse(key, {
        object: 'response',
        output: [
          { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '思考一' }, { type: 'summary_text', text: '思考二' }] },
          { type: 'message', id: 'm1', content: [{ type: 'output_text', text: '第一部分' }, { type: 'output_text', text: '第二部分' }] },
          { type: 'function_call', id: 'f1' },
        ],
      })
      const rows = monitor.list(key)
      expect(rows).toHaveLength(1)
      expect(rows[0].content).toBe('第一部分第二部分')
      expect(rows[0].reasoning).toBe('思考一思考二')
    })

    it('recordResponsesResponse：reasoning 项无 summary / summary 空数组：不产生思考文本', () => {
      const key = 'gpt-4::s2'
      monitor.recordResponsesResponse(key, {
        object: 'response',
        output: [
          { type: 'reasoning', id: 'r1' },
          { type: 'message', id: 'm1', content: [{ type: 'output_text', text: '回答' }] },
        ],
      })
      expect(monitor.list(key)).toHaveLength(1)
      expect(monitor.list(key)[0].reasoning).toBe('')
    })
  })

  describe('订阅与推送', () => {
    it('退订后不再收到事件；最后一个订阅者退订后 Map 清理', () => {
      const key = 'gpt-4::s1'
      const { events, unsubscribe } = messages(key, monitor)
      monitor.recordAssistant(key, 'A')
      unsubscribe()
      monitor.recordAssistant(key, 'B')
      expect(events).toHaveLength(1)
      expect(monitor.list(key)).toHaveLength(2)
    })

    it('异常订阅者自动摘除，不影响其它订阅者', () => {
      const key = 'gpt-4::s1'
      const good: MonitorEvent[] = []
      const badUnsubscribe = monitor.subscribe(key, () => {
        throw new Error('boom')
      })
      const goodUnsubscribe = monitor.subscribe(key, (e) => good.push(e))
      badUnsubscribe()
      monitor.recordAssistant(key, 'A')
      goodUnsubscribe()
      expect(good).toHaveLength(1)
    })

    it('无订阅者时 emit 零开销（不抛错）', () => {
      expect(() => monitor.recordAssistant('gpt-4::nobody', 'x')).not.toThrow()
    })
  })
})

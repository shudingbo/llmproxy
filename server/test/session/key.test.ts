// 会话键提取单元测试：header 优先、内容前缀 hash 兜底、同前缀稳定、前缀不同则不同
import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { extractSessionKey } from '../../src/session/key.js'

// 构造最小 express Request（只含 headers，仅被只读访问）
const makeReq = (headers: Record<string, unknown> = {}): Request =>
  ({ headers }) as unknown as Request

// 按与模块相同的口径计算期望的内容前缀 hash，用于校验 64 位 hex 与稳定性
const expectedHash = (messages: unknown[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        messages.slice(0, 2).map((m) => {
          const msg = (m ?? {}) as Record<string, unknown>
          const role = typeof msg.role === 'string' ? msg.role : ''
          // 与 key.ts 的 hashContentPrefix 保持同一口径：字符串原样、缺失视为空串、其余 JSON.stringify
          const content =
            typeof msg.content === 'string'
              ? msg.content
              : msg.content === undefined
                ? ''
                : JSON.stringify(msg.content)
          return [role, content]
        }),
      ),
    )
    .digest('hex')

describe('extractSessionKey', () => {
  it('header 存在（大小写不敏感 X-OPENWEBUI-CHAT-ID）→ 返回 header 值、client=open-webui', () => {
    const req = makeReq({ 'X-OPENWEBUI-CHAT-ID': 'chat-uuid-123' })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'chat-uuid-123', client: 'open-webui' })
  })

  it('header 值为空白 → 不命中，走内容 hash 兜底', () => {
    const req = makeReq({ 'x-openwebui-chat-id': '   ' })
    const body = { messages: [{ role: 'system' }, { role: 'user', content: '你好' }] }
    expect(extractSessionKey(req, body)?.client).toBe('content-hash')
  })

  it('无 header + messages 前 2 条 → 返回 64 位 hex、client=content-hash', () => {
    const body = { messages: [{ role: 'system' }, { role: 'user', content: '你好' }] }
    const result = extractSessionKey(makeReq(), body)
    expect(result).toBeDefined()
    expect(result!.client).toBe('content-hash')
    // 64 位小写十六进制
    expect(result!.raw).toMatch(/^[0-9a-f]{64}$/)
    expect(result!.raw).toBe(expectedHash(body.messages as unknown[]))
  })

  it('同前缀稳定：messages 增长（追加 assistant/user 消息）后，前 2 条不变 → hash 相同', () => {
    const short = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '你好' }] }
    const grown = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '再问一个' },
      ],
    }
    expect(extractSessionKey(makeReq(), grown)?.raw).toBe(extractSessionKey(makeReq(), short)?.raw)
  })

  it('前缀不同则不同：首条消息内容不同 → hash 不同', () => {
    const a = { messages: [{ role: 'user', content: '你好' }] }
    const b = { messages: [{ role: 'user', content: '你好吗' }] }
    const hashA = extractSessionKey(makeReq(), a)?.raw
    const hashB = extractSessionKey(makeReq(), b)?.raw
    expect(hashA).toBeDefined()
    expect(hashB).toBeDefined()
    expect(hashA).not.toBe(hashB)
  })

  it('messages 为空 / 非数组 / 缺失 → undefined', () => {
    expect(extractSessionKey(makeReq(), { messages: [] })).toBeUndefined()
    expect(extractSessionKey(makeReq(), { messages: 'not-an-array' })).toBeUndefined()
    expect(extractSessionKey(makeReq(), {})).toBeUndefined()
  })

  it('content 缺失（undefined）与空串等价：hash 相同', () => {
    const noContent = { messages: [{ role: 'system' }, { role: 'user' }] }
    const emptyContent = { messages: [{ role: 'system' }, { role: 'user', content: '' }] }
    expect(extractSessionKey(makeReq(), noContent)?.raw).toBe(
      extractSessionKey(makeReq(), emptyContent)?.raw,
    )
  })

  it('content 为 null：JSON.stringify(null) 为 "null"，与 content: "null" 字符串 hash 相同', () => {
    const withNull = { messages: [{ role: 'system' }, { role: 'user', content: null }] }
    const withStringNull = { messages: [{ role: 'system' }, { role: 'user', content: 'null' }] }
    expect(() => extractSessionKey(makeReq(), withNull)).not.toThrow()
    expect(extractSessionKey(makeReq(), withNull)?.raw).toBe(
      extractSessionKey(makeReq(), withStringNull)?.raw,
    )
  })

  it('content 为多模态数组：数组参与哈希与纯字符串不同，相同数组内容 hash 稳定', () => {
    const withArray = { messages: [{ role: 'user', content: [{ type: 'image', url: 'a' }] }] }
    const withString = { messages: [{ role: 'user', content: 'a' }] }
    const hashArray = extractSessionKey(makeReq(), withArray)?.raw
    const hashString = extractSessionKey(makeReq(), withString)?.raw
    expect(hashArray).toBeDefined()
    expect(hashString).toBeDefined()
    expect(hashArray).not.toBe(hashString)
    expect(extractSessionKey(makeReq(), withArray)?.raw).toBe(hashArray)
  })

  it('header 优先：同时有 header 和 messages → 返回 header 值', () => {
    const req = makeReq({ 'x-openwebui-chat-id': 'chat-uuid-456' })
    const body = { messages: [{ role: 'user', content: '你好' }] }
    expect(extractSessionKey(req, body)).toEqual({ raw: 'chat-uuid-456', client: 'open-webui' })
  })
})

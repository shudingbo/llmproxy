// 会话键提取单元测试：header 优先、内容前缀 hash 兜底、同前缀稳定、前缀不同则不同
import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { buildUpstreamSessionHeaders, extractSessionKey } from '../../src/session/key.js'

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

// 按与模块相同的口径计算期望的 github 分支 hash：
// 取「第 1 个 assistant 之前」的消息（无 assistant 则取全部），序列化口径同上
const expectedGithubHash = (messages: unknown[]): string => {
  const firstAssistantIndex = messages.findIndex((m) => {
    const msg = (m ?? {}) as Record<string, unknown>
    return msg.role === 'assistant'
  })
  const prefix = firstAssistantIndex === -1 ? messages : messages.slice(0, firstAssistantIndex)
  return createHash('sha256')
    .update(
      JSON.stringify(
        prefix.map((m) => {
          const msg = (m ?? {}) as Record<string, unknown>
          const role = typeof msg.role === 'string' ? msg.role : ''
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
}

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

  it('header X-Session-Id 非 ywnrs 前缀 → client=x-session-id，值 trim', () => {
    const req = makeReq({ 'x-session-id': '  abc-123  ' })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'abc-123', client: 'x-session-id' })
  })

  it('header X-Session-Id 大小写不敏感（X-SESSION-ID）→ 命中', () => {
    const req = makeReq({ 'X-SESSION-ID': 'sess-789' })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'sess-789', client: 'x-session-id' })
  })

  it('header X-Session-Id 值以 ywnrs 开头 → client=ywnrs', () => {
    const req = makeReq({ 'x-session-id': 'ywnrs-uuid-001' })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'ywnrs-uuid-001', client: 'ywnrs' })
  })

  it('header X-Session-Id 值以 YWNRS 大写开头 → 区分大小写不归类 ywnrs', () => {
    const req = makeReq({ 'x-session-id': 'YWNRS-uuid-001' })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'YWNRS-uuid-001', client: 'x-session-id' })
  })

  it('header X-Session-Id 值为空白 → 不命中，走内容 hash 兜底', () => {
    const req = makeReq({ 'x-session-id': '   ' })
    const body = { messages: [{ role: 'user', content: '你好' }] }
    expect(extractSessionKey(req, body)?.client).toBe('content-hash')
  })

  it('优先级：X-OpenWebUI-Chat-Id 优先于 X-Session-Id → 返回 open-webui', () => {
    const req = makeReq({
      'x-openwebui-chat-id': 'chat-uuid-789',
      'x-session-id': 'sess-abc',
    })
    expect(extractSessionKey(req, {})).toEqual({ raw: 'chat-uuid-789', client: 'open-webui' })
  })

  it('优先级：X-Session-Id 优先于内容前缀 hash', () => {
    const req = makeReq({ 'x-session-id': 'sess-xyz' })
    const body = { messages: [{ role: 'user', content: '你好' }] }
    expect(extractSessionKey(req, body)).toEqual({ raw: 'sess-xyz', client: 'x-session-id' })
  })
})

describe('extractSessionKey github baggage 分支', () => {
  it('baggage 值含 copilot → client=github，raw 为 64 位 hex 且与口径计算一致', () => {
    const req = makeReq({ baggage: 'vs.copilot.InitiatorType = user' })
    const body = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '你好' }] }
    const result = extractSessionKey(req, body)
    expect(result).toBeDefined()
    expect(result!.client).toBe('github')
    expect(result!.raw).toMatch(/^[0-9a-f]{64}$/)
    expect(result!.raw).toBe(expectedGithubHash(body.messages as unknown[]))
  })

  it('baggage 值含大小写混合 Copilot → 仍命中 github（验证转小写）', () => {
    const req = makeReq({ baggage: 'Copilot=1; x=2' })
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    const result = extractSessionKey(req, body)
    expect(result).toBeDefined()
    expect(result!.client).toBe('github')
  })

  it('baggage 头存在但不含 copilot → 不走 github，走 content-hash', () => {
    const req = makeReq({ baggage: 'other-key=value' })
    const body = { messages: [{ role: 'user', content: '你好' }] }
    const result = extractSessionKey(req, body)
    expect(result).toBeDefined()
    expect(result!.client).toBe('content-hash')
    expect(result!.raw).toBe(expectedHash(body.messages as unknown[]))
  })

  it('无 baggage 头 → 不走 github（只有 messages → content-hash）', () => {
    const body = { messages: [{ role: 'user', content: '你好' }] }
    const result = extractSessionKey(makeReq(), body)
    expect(result).toBeDefined()
    expect(result!.client).toBe('content-hash')
  })

  it('github hash 稳定性：第 1 个 assistant 之前的消息未变 → hash 相同', () => {
    const short = {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '你好' }],
    }
    const grown = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '再问一个' },
      ],
    }
    const req = makeReq({ baggage: 'vs.copilot.InitiatorType = user' })
    expect(extractSessionKey(req, grown)?.raw).toBe(extractSessionKey(req, short)?.raw)
  })

  it('github 分支：无 assistant 取全部消息 → [user] 与 [user, assistant, user] hash 相同', () => {
    const onlyUser = { messages: [{ role: 'user', content: 'hi' }] }
    const withAssistant = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
    }
    const req = makeReq({ baggage: 'vs.copilot.InitiatorType = user' })
    expect(extractSessionKey(req, onlyUser)?.raw).toBe(extractSessionKey(req, withAssistant)?.raw)
  })

  it('github 分支：首条 user 内容不同 → hash 不同', () => {
    const a = { messages: [{ role: 'user', content: '你好' }] }
    const b = { messages: [{ role: 'user', content: '你好吗' }] }
    const req = makeReq({ baggage: 'vs.copilot.InitiatorType = user' })
    const hashA = extractSessionKey(req, a)?.raw
    const hashB = extractSessionKey(req, b)?.raw
    expect(hashA).toBeDefined()
    expect(hashB).toBeDefined()
    expect(hashA).not.toBe(hashB)
  })

  it('baggage 头为数组值（重复 header）→ 取第一个参与判断', () => {
    // 第一个含 copilot → 命中 github
    const firstHits = makeReq({ baggage: ['vs.copilot.InitiatorType = user', 'other=x'] })
    expect(extractSessionKey(firstHits, { messages: [{ role: 'user', content: 'hi' }] })?.client).toBe(
      'github',
    )
    // 第一个不含 copilot、第二个含 → 以第一个为准，不命中 github，走 content-hash
    const firstMisses = makeReq({ baggage: ['other=x', 'vs.copilot.InitiatorType = user'] })
    const result = extractSessionKey(firstMisses, { messages: [{ role: 'user', content: 'hi' }] })
    expect(result?.client).toBe('content-hash')
  })
})

describe('buildUpstreamSessionHeaders', () => {
  it('原始请求带 x-session-id（大小写不敏感）→ 保留原值并转发其余头，剔除黑名单', () => {
    const req = makeReq({
      'X-Session-Id': 'client-session-1',
      'user-agent': 'test-agent',
      authorization: 'Bearer client-token',
      host: 'example.com',
      'content-length': '100',
    })
    const session = { raw: 'computed-hash', client: 'content-hash' as const }
    const result = buildUpstreamSessionHeaders(req, session)
    // 客户端显式会话原样保留，其余自带头转发
    expect(result?.['x-session-id']).toBe('client-session-1')
    expect(result?.['user-agent']).toBe('test-agent')
    // 鉴权 / 传输层头被剔除（绝不上行）
    expect(result?.['authorization']).toBeUndefined()
    expect(result?.['host']).toBeUndefined()
    expect(result?.['content-length']).toBeUndefined()
  })

  it('原始请求没有 x-session-id + 有计算 session → 转发其余头并补充 x-session-id', () => {
    const req = makeReq({ 'user-agent': 'test', 'X-OpenWebUI-Chat-Id': 'chat-uuid-9' })
    const session = { raw: 'chat-uuid-9', client: 'open-webui' as const }
    const result = buildUpstreamSessionHeaders(req, session)
    expect(result?.['x-session-id']).toBe('chat-uuid-9')
    expect(result?.['user-agent']).toBe('test')
    // 计算来源头（X-OpenWebUI-Chat-Id）也被转发，保持原始请求头语义
    expect(result?.['x-openwebui-chat-id']).toBe('chat-uuid-9')
  })

  it('原始请求 x-session-id 为空白 → 视为缺失，用计算 session 补充', () => {
    const req = makeReq({ 'x-session-id': '   ' })
    const session = { raw: 'hash-abc', client: 'content-hash' as const }
    expect(buildUpstreamSessionHeaders(req, session)?.['x-session-id']).toBe('hash-abc')
  })

  it('原始请求与计算 session 皆无 → undefined（不添加会话头）', () => {
    expect(buildUpstreamSessionHeaders(makeReq(), undefined)).toBeUndefined()
  })

  it('user-agent 含 opencode + 带 X-Session-Id/x-session-affinity → 提升为 x-opencode-session', () => {
    const req = makeReq({
      'user-agent': 'opencode/0.4.12 (cli)',
      'X-Session-Id': 'ses_abc123',
      'x-session-affinity': 'ses_abc123',
    })
    const result = buildUpstreamSessionHeaders(req, { raw: 'computed-hash', client: 'content-hash' as const })
    expect(result?.['x-opencode-session']).toBe('ses_abc123')
    // 原始会话头原样保留
    expect(result?.['x-session-id']).toBe('ses_abc123')
    expect(result?.['x-session-affinity']).toBe('ses_abc123')
  })

  it('user-agent 含 opencode 但仅有 x-session-affinity → 提升且不丢弃会话头', () => {
    const req = makeReq({ 'user-agent': 'opencode/0.4.12 (cli)', 'x-session-affinity': 'ses_xyz' })
    const result = buildUpstreamSessionHeaders(req, undefined)
    expect(result?.['x-opencode-session']).toBe('ses_xyz')
    expect(result?.['x-session-affinity']).toBe('ses_xyz')
  })

  it('user-agent 含 OpenCode（大写）→ 大小写不敏感命中提升', () => {
    const req = makeReq({ 'user-agent': 'OpenCode TUI', 'X-Session-Id': 'ses_upper' })
    const result = buildUpstreamSessionHeaders(req, undefined)
    expect(result?.['x-opencode-session']).toBe('ses_upper')
  })

  it('user-agent 不含 opencode → 不注入 x-opencode-session', () => {
    const req = makeReq({ 'user-agent': 'curl/8.0', 'X-Session-Id': 'ses_curl' })
    const result = buildUpstreamSessionHeaders(req, undefined)
    expect(result?.['x-opencode-session']).toBeUndefined()
    expect(result?.['x-session-id']).toBe('ses_curl')
  })
})

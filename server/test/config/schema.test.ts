// 模式测试：默认值补齐、非法字段拒绝
import { describe, expect, it } from 'vitest'
import {
  AuthConfigSchema,
  ConfigSchema,
  RoutingSchema,
  UpstreamCandidateSchema,
  UpstreamSchema,
} from '../../src/config/schema.js'

// 一份完整合法的配置样本（各测试复用）
const validConfig = {
  upstreams: [
    {
      id: 'openai-main',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      timeoutMs: 60000,
      disabled: false,
    },
  ],
  downstreamModels: {
    'gpt-4': {
      disabled: false,
      candidates: [{ upstreamId: 'openai-main', model: 'gpt-4' }],
    },
  },
}

describe('ConfigSchema', () => {
  it('合法配置解析成功，且缺省字段自动补齐', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    // timeoutMs / disabled 显式给出时原样保留
    expect(result.data.upstreams[0].timeoutMs).toBe(60000)
    expect(result.data.upstreams[0].disabled).toBe(false)
  })

  it('缺省字段应用默认值（timeoutMs 30000、disabled false）', () => {
    const result = ConfigSchema.safeParse({
      upstreams: [{ id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }],
      downstreamModels: { 'm1': { disabled: false, candidates: [{ upstreamId: 'a', model: 'm1', disabled: false }] } },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.upstreams[0].timeoutMs).toBe(30000)
    expect(result.data.upstreams[0].disabled).toBe(false)
  })

  it('upstreams 为空数组时拒绝', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, upstreams: [] })
    expect(result.success).toBe(false)
  })

  it('downstreamModels 为空对象时仍接受（z.record 无长度约束）', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, downstreamModels: {} })
    expect(result.success).toBe(true)
  })

  it('候选列表为空数组时拒绝（min(1)）', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      downstreamModels: { 'gpt-4': { disabled: false, candidates: [] } },
    })
    expect(result.success).toBe(false)
  })
})

describe('UpstreamSchema', () => {
  it('id 为空串时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: '', baseUrl: 'https://x.example', apiKey: 'k' }).success).toBe(false)
  })

  it('baseUrl 非合法 URL 时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: 'a', baseUrl: 'not-a-url', apiKey: 'k' }).success).toBe(false)
  })

  it('apiKey 为空串时拒绝', () => {
    expect(UpstreamSchema.safeParse({ id: 'a', baseUrl: 'https://x.example', apiKey: '' }).success).toBe(false)
  })

  it('timeoutMs 非正整数时拒绝（负数 / 小数 / 字符串）', () => {
    const base = { id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: -1 }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: 1.5 }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, timeoutMs: '30000' }).success).toBe(false)
  })

  it('max_context_length 不再属于 UpstreamSchema（已迁移到 UpstreamCandidate）', () => {
    const result = UpstreamSchema.safeParse({
      id: 'a',
      baseUrl: 'https://x.example',
      apiKey: 'k',
      max_context_length: 32768,
    } as unknown)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.data as Record<string, unknown>).max_context_length).toBeUndefined()
  })

  it('responsesApi 缺省时为 convert', () => {
    const result = UpstreamSchema.safeParse({ id: 'a', baseUrl: 'https://x.example', apiKey: 'k' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.responsesApi).toBe('convert')
  })

  it('responsesApi 合法值 native / convert 均接受', () => {
    const base = { id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: 'native' }).success).toBe(true)
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: 'convert' }).success).toBe(true)
  })

  it('responsesApi 非法值拒绝（auto / passthrough / 空串等，z.enum 白名单）', () => {
    const base = { id: 'a', baseUrl: 'https://x.example', apiKey: 'k' }
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: 'auto' }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: 'passthrough' }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: '' }).success).toBe(false)
    expect(UpstreamSchema.safeParse({ ...base, responsesApi: 1 }).success).toBe(false)
  })
})

describe('UpstreamCandidateSchema.max_context_length', () => {
  it('为合法正整数时原样保留', () => {
    const result = UpstreamCandidateSchema.safeParse({
      upstreamId: 'a',
      model: 'm1',
      max_context_length: 32768,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.max_context_length).toBe(32768)
  })

  it('缺省时为 undefined（不报错）', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.max_context_length).toBeUndefined()
  })

  it('为 null 时接受（显式清空）', () => {
    const result = UpstreamCandidateSchema.safeParse({
      upstreamId: 'a',
      model: 'm1',
      max_context_length: null,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.max_context_length).toBeNull()
  })

  it('为负数 / 0 / 小数 / 字符串时拒绝', () => {
    const base = { upstreamId: 'a', model: 'm1' }
    expect(UpstreamCandidateSchema.safeParse({ ...base, max_context_length: -1 }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, max_context_length: 0 }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, max_context_length: 1.5 }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, max_context_length: '32768' }).success).toBe(false)
  })
})

describe('UpstreamCandidateSchema 字段收敛（候选级 disabled 已移除）', () => {
  // zod v4 默认 strip 模式，候选级 disabled 字段会被静默剔除；
  // 此处验明「字段被剥离、不会进 data」，实际写入 llmproxy.jsonc 时归一化层不会把 disabled 放回，
  // 见 loader.ts 的 normalizeDownstreamAliasEntry（只取 { disabled, candidates }，不会向候选塞 disabled）。
  it('候选 schema 不暴露 disabled 字段（多余键被剥离）', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.data as Record<string, unknown>).disabled).toBeUndefined()
  })

  it('带 disabled 键的候选也能解析，但 disabled 不会落到结果中', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1', disabled: true })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.data as Record<string, unknown>).disabled).toBeUndefined()
  })
})

describe('UpstreamCandidateSchema.capabilities', () => {
  it('缺省时为 undefined（不报错，向后兼容）', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.capabilities).toBeUndefined()
  })

  it('接受字符串数组（任意值，无枚举约束）', () => {
    const result = UpstreamCandidateSchema.safeParse({
      upstreamId: 'a',
      model: 'm1',
      capabilities: ['completion', 'vision', 'embedding'],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.capabilities).toEqual(['completion', 'vision', 'embedding'])
  })

  it('接受空数组', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1', capabilities: [] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.capabilities).toEqual([])
  })

  it('非数组（字符串 / 数字 / 布尔）时拒绝', () => {
    const base = { upstreamId: 'a', model: 'm1' }
    expect(UpstreamCandidateSchema.safeParse({ ...base, capabilities: 'completion' }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, capabilities: 42 }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, capabilities: true }).success).toBe(false)
  })

  it('数组中含非字符串元素时拒绝', () => {
    const base = { upstreamId: 'a', model: 'm1' }
    expect(UpstreamCandidateSchema.safeParse({ ...base, capabilities: ['completion', 42] }).success).toBe(false)
  })
})

describe('UpstreamCandidateSchema.reasoningSplit', () => {
  it('缺省时为 undefined（不报错，向后兼容）', () => {
    const result = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.reasoningSplit).toBeUndefined()
  })

  it('显式 true / false 均原样保留', () => {
    const on = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1', reasoningSplit: true })
    expect(on.success).toBe(true)
    if (on.success) expect(on.data.reasoningSplit).toBe(true)
    const off = UpstreamCandidateSchema.safeParse({ upstreamId: 'a', model: 'm1', reasoningSplit: false })
    expect(off.success).toBe(true)
    if (off.success) expect(off.data.reasoningSplit).toBe(false)
  })

  it('非布尔值（字符串 / 数字）时拒绝', () => {
    const base = { upstreamId: 'a', model: 'm1' }
    expect(UpstreamCandidateSchema.safeParse({ ...base, reasoningSplit: 'true' }).success).toBe(false)
    expect(UpstreamCandidateSchema.safeParse({ ...base, reasoningSplit: 1 }).success).toBe(false)
  })
})

describe('server 配置节（进程级 server 配置：host / port / bodyLimit）', () => {
  it('未指定 server 时 ConfigSchema 仍接受（向上兼容现有配置）', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server).toBeUndefined()
  })

  it('指定 host/port 时按原样保留，bodyLimit 走缺省 10mb', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      server: { host: '0.0.0.0', port: 8080 },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server).toEqual({ host: '0.0.0.0', port: 8080, bodyLimit: '10mb' })
  })

  it('只指定 host 时 port 走缺省 3000', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      server: { host: '0.0.0.0' },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server?.host).toBe('0.0.0.0')
    expect(result.data.server?.port).toBe(3000)
  })

  it('只指定 port 时 host 走缺省 127.0.0.1', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      server: { port: 9000 },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server?.host).toBe('127.0.0.1')
    expect(result.data.server?.port).toBe(9000)
  })

  it('port 越界（0 / 65536 / 负数 / 小数）一律拒绝', () => {
    const mk = (port: unknown): boolean =>
      ConfigSchema.safeParse({ ...validConfig, server: { host: '0.0.0.0', port } }).success
    expect(mk(0)).toBe(false)
    expect(mk(65536)).toBe(false)
    expect(mk(-1)).toBe(false)
    expect(mk(1.5)).toBe(false)
    expect(mk('3000')).toBe(false)
  })

  it('host 为空串时拒绝', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, server: { host: '', port: 3000 } })
    expect(result.success).toBe(false)
  })

  it('port 等于边界值 1 与 65535 接受', () => {
    expect(
      ConfigSchema.safeParse({ ...validConfig, server: { host: '127.0.0.1', port: 1 } }).success,
    ).toBe(true)
    expect(
      ConfigSchema.safeParse({ ...validConfig, server: { host: '127.0.0.1', port: 65535 } }).success,
    ).toBe(true)
  })

  it('显式指定 server 空对象时 bodyLimit 走缺省 10mb', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, server: {} })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server).toEqual({ host: '127.0.0.1', port: 3000, bodyLimit: '10mb' })
  })

  it('bodyLimit 接受字符串（如 "2mb"）', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, server: { bodyLimit: '2mb' } })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server?.bodyLimit).toBe('2mb')
  })

  it('bodyLimit 接受正整数字节数（如 2048）', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, server: { bodyLimit: 2048 } })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.server?.bodyLimit).toBe(2048)
  })

  it('bodyLimit 拒绝空串 / 负数 / 0 / 小数 / 布尔值', () => {
    const mk = (bodyLimit: unknown): boolean =>
      ConfigSchema.safeParse({ ...validConfig, server: { bodyLimit } }).success
    expect(mk('')).toBe(false)
    expect(mk(-1)).toBe(false)
    expect(mk(0)).toBe(false)
    expect(mk(1.5)).toBe(false)
    expect(mk(true)).toBe(false)
  })
})

describe('routing 配置节（会话亲和）', () => {
  it('未指定 routing 时 ConfigSchema 仍接受（向上兼容旧配置）', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.routing).toBeUndefined()
  })

  it('旧配置结构（upstreams + downstreamModels + server）不含 routing 仍 parse 成功', () => {
    const oldConfig = {
      ...validConfig,
      server: { host: '0.0.0.0', port: 8080 },
    }
    const result = ConfigSchema.safeParse(oldConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.routing).toBeUndefined()
    expect(result.data.server).toEqual({ host: '0.0.0.0', port: 8080, bodyLimit: '10mb' })
  })

  it('routing.sessionAffinity 缺省时全部取默认值', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, routing: {} })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.routing?.sessionAffinity).toEqual({
      enabled: true,
      cleanupMaxAgeMs: 604800000,
      cleanupIntervalMs: 3600000,
    })
  })

  it('只写 sessionAffinity.enabled=false 时其余键取默认值', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      routing: { sessionAffinity: { enabled: false } },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.routing?.sessionAffinity).toEqual({
      enabled: false,
      cleanupMaxAgeMs: 604800000,
      cleanupIntervalMs: 3600000,
    })
  })

  it('cleanupMaxAgeMs / cleanupIntervalMs 显式给出时原样保留', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      routing: { sessionAffinity: { cleanupMaxAgeMs: 0, cleanupIntervalMs: 0 } },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.routing?.sessionAffinity).toEqual({
      enabled: true,
      cleanupMaxAgeMs: 0,
      cleanupIntervalMs: 0,
    })
  })

  it('cleanupMaxAgeMs 为负数或字符串时拒绝', () => {
    expect(
      ConfigSchema.safeParse({
        ...validConfig,
        routing: { sessionAffinity: { cleanupMaxAgeMs: -1 } },
      }).success,
    ).toBe(false)
    expect(
      ConfigSchema.safeParse({
        ...validConfig,
        routing: { sessionAffinity: { cleanupMaxAgeMs: '604800000' } },
      }).success,
    ).toBe(false)
  })

  it('cleanupIntervalMs 为负数或小数时拒绝', () => {
    expect(
      ConfigSchema.safeParse({
        ...validConfig,
        routing: { sessionAffinity: { cleanupIntervalMs: -1 } },
      }).success,
    ).toBe(false)
    expect(
      ConfigSchema.safeParse({
        ...validConfig,
        routing: { sessionAffinity: { cleanupIntervalMs: 1.5 } },
      }).success,
    ).toBe(false)
  })

  it('enabled 为字符串时拒绝', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      routing: { sessionAffinity: { enabled: 'false' } },
    })
    expect(result.success).toBe(false)
  })
})

describe('RoutingSchema', () => {
  it('空对象解析成功且取全部默认值', () => {
    const result = RoutingSchema.safeParse({})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.sessionAffinity).toEqual({
      enabled: true,
      cleanupMaxAgeMs: 604800000,
      cleanupIntervalMs: 3600000,
    })
  })
})

describe('AuthConfigSchema', () => {
  it('空对象解析成功且取全部默认值（enabled=false, keyBytes=24, cleanupRetentionDays=7）', () => {
    const result = AuthConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({
      enabled: false,
      keyBytes: 24,
      cleanupRetentionDays: 7,
    })
  })

  it('仅写 enabled=true，其余字段取默认值', () => {
    const result = AuthConfigSchema.safeParse({ enabled: true })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.enabled).toBe(true)
    expect(result.data.keyBytes).toBe(24)
    expect(result.data.cleanupRetentionDays).toBe(7)
  })

  it('cleanupRetentionDays=0 允许（过期即清理）', () => {
    const result = AuthConfigSchema.safeParse({ cleanupRetentionDays: 0 })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.cleanupRetentionDays).toBe(0)
  })

  it('cleanupRetentionDays 为负或超 3650 拒绝', () => {
    expect(AuthConfigSchema.safeParse({ cleanupRetentionDays: -1 }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ cleanupRetentionDays: 3651 }).success).toBe(false)
  })
})

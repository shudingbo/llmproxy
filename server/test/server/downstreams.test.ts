// 下游清单单元测试 + /admin/api/health 返回值断言
// 验证清单内容真实、与 openai.ts / ollama.ts / admin.ts 的实际注册保持一致；
// 验证 health 接口在响应中暴露 downstreams 字段，前端可据此渲染 Dashboard
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { createApp } from '../../src/server/index.js'
import { DOWNSTREAM_ENDPOINTS, type DownstreamEndpoint } from '../../src/server/downstreams.js'

// 基础配置：单上游 + 单别名；端口不可达不影响 health 状态码
const BASE_CONFIG = {
  upstreams: [{ id: 'u1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', timeoutMs: 5000, disabled: false }],
  downstreamModels: {
    'gpt-4': [{ upstreamId: 'u1', model: 'gpt-4-u1' }],
  },
}

let tmpDir = ''
let store: ConfigStore
let webDistPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-downstreams-'))
  vi.stubEnv('HOME', tmpDir)
  vi.stubEnv('USERPROFILE', tmpDir)
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  webDistPath = join(tmpDir, 'web-dist')
  mkdirSync(webDistPath, { recursive: true })
  writeFileSync(join(webDistPath, 'index.html'), '<!doctype html>')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('下游清单 DOWNSTREAM_ENDPOINTS', () => {
  it('条目形如 { type, method, path, summary }，且 path 以 / 开头', () => {
    expect(DOWNSTREAM_ENDPOINTS.length).toBeGreaterThan(0)
    for (const ep of DOWNSTREAM_ENDPOINTS) {
      expect(['openai', 'ollama', 'admin']).toContain(ep.type)
      expect(typeof ep.method).toBe('string')
      expect(ep.method.length).toBeGreaterThan(0)
      expect(ep.path.startsWith('/')).toBe(true)
      expect(typeof ep.summary).toBe('string')
      expect(ep.summary.length).toBeGreaterThan(0)
    }
  })

  it('OpenAI 兼容下游至少包含 /v1/models、/v1/chat/completions 与 /v1/responses', () => {
    const openai = DOWNSTREAM_ENDPOINTS.filter((e) => e.type === 'openai')
    const paths = openai.map((e) => `${e.method} ${e.path}`)
    expect(paths).toContain('GET /v1/models')
    expect(paths).toContain('POST /v1/chat/completions')
    expect(paths).toContain('POST /v1/responses')
  })

  it('Ollama 兼容下游至少包含 /api/tags 与 /api/chat', () => {
    const ollama = DOWNSTREAM_ENDPOINTS.filter((e) => e.type === 'ollama')
    const paths = ollama.map((e) => `${e.method} ${e.path}`)
    expect(paths).toContain('GET /api/tags')
    expect(paths).toContain('POST /api/chat')
  })

  it('管理端下游覆盖所有 admin 路由，至少含 /admin/api/health 与 /admin/api/upstreams', () => {
    const admin = DOWNSTREAM_ENDPOINTS.filter((e) => e.type === 'admin')
    const paths = admin.map((e) => `${e.method} ${e.path}`)
    expect(paths).toContain('GET /admin/api/health')
    expect(paths).toContain('GET /admin/api/upstreams')
    expect(paths).toContain('POST /admin/api/upstreams')
    expect(paths).toContain('PUT /admin/api/upstreams/:id')
    expect(paths).toContain('DELETE /admin/api/upstreams/:id')
  })

  it('同一 path 与 method 组合不重复', () => {
    const seen = new Set<string>()
    for (const ep of DOWNSTREAM_ENDPOINTS) {
      const key = `${ep.method} ${ep.path}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('GET /admin/api/health', () => {
  it('响应包含 downstreams 字段，且内容与 DOWNSTREAM_ENDPOINTS 一致（用引用相等作为单一真相源校验）', async () => {
    const app = createApp({ store, webDistPath })
    const res = await request(app).get('/admin/api/health')
    expect(res.status).toBe(200)
    const body = res.body as { downstreams: DownstreamEndpoint[] }
    expect(body.downstreams).toBeDefined()
    // 启动日志与 web 拿到的清单保证完全一致：
    // 经过 JSON 序列化已丢失引用相等，改用深度相等校验内容
    expect(body.downstreams).toStrictEqual(DOWNSTREAM_ENDPOINTS)
  })

  it('保留原有 status / uptime / version / upstreams 字段不变', async () => {
    const app = createApp({ store, webDistPath })
    const res = await request(app).get('/admin/api/health')
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.version).toBe('string')
    expect(body.upstreams).toEqual({ u1: 'healthy' })
  })

  it('health 同时返回下行流的 host / port / baseUrl / listenSource', async () => {
    const app = createApp({ store, webDistPath })
    const res = await request(app).get('/admin/api/health')
    const body = res.body as { host: string; port: number; baseUrl: string; listenSource: string }
    expect(body.host).toBe('127.0.0.1')
    expect(body.port).toBe(3000)
    // 通配监听下 baseUrl 用本机局域网 IP 生成（测试环境网卡 IP 不固定，只做形状断言）
    expect(body.baseUrl.startsWith('http://')).toBe(true)
    expect(body.baseUrl.endsWith(':3000')).toBe(true)
    expect(body.baseUrl.includes('0.0.0.0')).toBe(false)
    expect(body.listenSource).toBe('default')
  })
})

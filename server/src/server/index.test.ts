// 单端口装配层测试：supertest 验证 API 路由挂载、静态 SPA、index 回退与产物缺失时的 503
// 覆盖：/admin/api/health 200、/v1/models 200、/ 返回 HTML 或 503、/admin/upstreams 404
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../config/store.js'
import { createApp } from './index.js'

// 基础配置：单个上游 + gpt-4 别名（上游地址不可达，模型列表聚合走 catch 返回空，不影响状态码）
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
  // 独立临时目录：配置 + 伪 web/dist + 日志目录（stub USERPROFILE/HOME 使日志也落在临时目录）
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-assembly-'))
  vi.stubEnv('HOME', tmpDir)
  vi.stubEnv('USERPROFILE', tmpDir)
  const cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  webDistPath = join(tmpDir, 'web-dist')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpDir, { recursive: true, force: true })
})

// 构建带伪 web/dist（含 index.html）的应用
function buildAppWithUi(): ReturnType<typeof createApp> {
  mkdirSync(webDistPath, { recursive: true })
  writeFileSync(join(webDistPath, 'index.html'), '<!doctype html><title>llmproxy admin</title>')
  return createApp({ store, webDistPath })
}

describe('单端口装配 createApp', () => {
  it('GET /admin/api/health 返回 200 JSON（管理端路由已挂载）', async () => {
    const app = buildAppWithUi()
    const res = await request(app).get('/admin/api/health')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    const body = res.body as { status: string }
    expect(body.status).toBe('ok')
  })

  it('GET /v1/models 返回 200（OpenAI 兼容路由已挂载；上游不可达时列表为空）', async () => {
    const app = buildAppWithUi()
    const res = await request(app).get('/v1/models')
    expect(res.status).toBe(200)
    const body = res.body as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('GET / 返回 index.html（web/dist 存在时）', async () => {
    const app = buildAppWithUi()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/html/)
    expect(res.text).toContain('llmproxy admin')
  })

  it('GET / 返回 503 JSON（web/dist/index.html 缺失时，不抛 ENOENT）', async () => {
    // 不创建 web-dist 目录 / index.html，模拟全新检出未构建 web 包
    const app = createApp({ store, webDistPath })
    const res = await request(app).get('/')
    expect(res.status).toBe(503)
    const body = res.body as { error: string; message: string }
    expect(body.error).toBe('admin_ui_not_built')
    expect(body.message).toContain('pnpm --filter @llmproxy/web build')
  })

  it('GET /admin/upstreams 返回 404（不在 /admin/api 前缀下，回退规则亦不匹配）', async () => {
    const app = buildAppWithUi()
    const res = await request(app).get('/admin/upstreams')
    expect(res.status).toBe(404)
  })
})

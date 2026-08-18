// 管理端系统配置保存端点测试：PUT /admin/api/config（server / routing / auth 三节部分更新）
// 覆盖：三节各自的写回与 restartRequired 语义、非法值 400（msg 带字段路径）、
//       缺省键不修改既有值（含 auth 节 prefault 默认值不得覆盖既有值的回归）、写回后落盘内容
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { LogStore } from '../../src/logstore/index.js'
import { SessionStore } from '../../src/session/db.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { registerAdminRoutes } from '../../src/server/admin.js'
import type { OpenAIUpstreamClient } from '../../src/upstream/openai.js'

// 基础配置模板：单上游 + 单别名；刻意不含 server / routing / auth 三节（缺省形态）
const BASE_CONFIG = {
  upstreams: [
    {
      id: 'u1',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-long-1234',
      timeoutMs: 5000,
      disabled: false,
      responsesApi: 'convert',
    },
  ],
  downstreamModels: {
    'gpt-4': {
      disabled: false,
      candidates: [{ upstreamId: 'u1', model: 'gpt-4' }],
    },
  },
}

// 落盘文件的结构化视图（store 以 JSON.stringify 写盘，可直接 JSON.parse）
interface OnDiskConfig {
  upstreams: unknown
  downstreamModels: unknown
  server?: { host: string; port: number; bodyLimit: string | number }
  routing?: { sessionAffinity: { enabled: boolean; cleanupMaxAgeMs: number; cleanupIntervalMs: number } }
  auth?: { enabled: boolean; keyBytes: number; cleanupRetentionDays: number }
}

// 每次测试的共享状态
let tmpDir = ''
let cfgPath = ''
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let logStore: LogStore
let apiKeyStore: ApiKeyStore
let app: Express

// 构造被测应用：express.json（装配层职责）+ 管理端路由
function buildApp(): void {
  app = express()
  app.use(express.json())
  registerAdminRoutes(app, {
    store,
    getUpstreamClient: (): OpenAIUpstreamClient | undefined => undefined,
    stats,
    sessionStore,
    logStore,
    apiKeyStore,
  })
}

beforeEach(() => {
  // 每个用例独立的临时配置目录；同时把日志目录（homedir/llmproxy/logs）重定向到临时目录
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-config-'))
  cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  sessionStore = new SessionStore(join(tmpDir, 'sessions.db'))
  logStore = new LogStore(join(tmpDir, 'logs.db'))
  apiKeyStore = new ApiKeyStore(join(tmpDir, 'apikeys.db'))
  buildApp()
  // Windows 读 USERPROFILE，POSIX 读 HOME：两个都 stub 才跨平台生效
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  // 先关库再删目录：WAL 模式下文件句柄保持打开，先关连接避免删除竞态
  for (const close of [sessionStore.close, logStore.close, apiKeyStore.close]) {
    try {
      close()
    } catch {
      // 连接已关闭，无需处理
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('系统配置保存 PUT /admin/api/config', () => {
  it('只改 server 节：内存与文件均更新，restartRequired 含 server，auth 节不进列表', async () => {
    const res = await request(app).put('/admin/api/config').send({ server: { host: '0.0.0.0', port: 8080 } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(typeof res.body.msg).toBe('string')
    expect(res.body.restartRequired).toEqual(['server'])
    // 内存态：server 节被 schema 默认值补齐后整体落库
    expect(store.get().server).toEqual({ host: '0.0.0.0', port: 8080, bodyLimit: '10mb' })
    // 落盘文件同步更新
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8')) as OnDiskConfig
    expect(onDisk.server).toEqual({ host: '0.0.0.0', port: 8080, bodyLimit: '10mb' })
  })

  it('只改 auth 节：restartRequired 为空（auth.enabled 每请求实时生效）', async () => {
    const res = await request(app).put('/admin/api/config').send({ auth: { enabled: true } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.restartRequired).toEqual([])
    // 内存态：auth 节默认值补齐
    expect(store.get().auth).toEqual({ enabled: true, keyBytes: 24, cleanupRetentionDays: 7 })
    // 落盘文件同步更新
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8')) as OnDiskConfig
    expect(onDisk.auth).toEqual({ enabled: true, keyBytes: 24, cleanupRetentionDays: 7 })
    // 响应 config 回显本次应用的节
    expect(res.body.config).toEqual({ auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 } })
  })

  it('只改 routing 节：restartRequired 含 routing', async () => {
    const res = await request(app)
      .put('/admin/api/config')
      .send({ routing: { sessionAffinity: { enabled: false } } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.restartRequired).toEqual(['routing'])
    // 内存态：sessionAffinity 其余键取默认
    expect(store.get().routing).toEqual({
      sessionAffinity: { enabled: false, cleanupMaxAgeMs: 604800000, cleanupIntervalMs: 3600000 },
    })
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['port=0', { server: { port: 0 } }, 'server.port'],
    ['port=99999', { server: { port: 99999 } }, 'server.port'],
    ['host 空串', { server: { host: '' } }, 'server.host'],
  ])('非法值（%s）返回 400：msg 带字段路径，配置不被修改', async (_label, payload, expectedPath) => {
    // 请求前快照（loadConfigFromFile 时 ConfigSchema 已把 auth 节 prefault 为默认值，不能断言 undefined）
    const before = JSON.parse(JSON.stringify(store.get())) as unknown
    const res = await request(app).put('/admin/api/config').send(payload)
    expect(res.status).toBe(400)
    expect(res.body.status).toBe(false)
    expect(res.body.error).toBe('invalid_config')
    // msg 为描述性字符串且列出字段路径与错误
    expect(typeof res.body.msg).toBe('string')
    expect(res.body.msg).toContain(expectedPath)
    // 结构化 issues 同样携带字段路径
    expect(Array.isArray(res.body.issues)).toBe(true)
    expect(res.body.issues.join('\n')).toContain(expectedPath)
    // 校验失败不写回：配置与请求前完全一致
    expect(store.get()).toEqual(before)
  })

  it('缺省键不修改既有值：先设 server.port=8080，再 PUT 只带 auth → port 保持 8080', async () => {
    const first = await request(app).put('/admin/api/config').send({ server: { port: 8080 } })
    expect(first.status).toBe(200)
    expect(store.get().server?.port).toBe(8080)

    const second = await request(app).put('/admin/api/config').send({ auth: { enabled: true } })
    expect(second.status).toBe(200)
    // server 节未被 auth 请求触碰
    expect(store.get().server).toEqual({ host: '127.0.0.1', port: 8080, bodyLimit: '10mb' })
    expect(store.get().auth).toEqual({ enabled: true, keyBytes: 24, cleanupRetentionDays: 7 })
    // 落盘内容同时保留两节
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8')) as OnDiskConfig
    expect(onDisk.server?.port).toBe(8080)
    expect(onDisk.auth?.enabled).toBe(true)
  })

  it('auth 节既有值不会被缺省键覆盖（prefault 回归）：先启用 auth，再只改 server', async () => {
    const first = await request(app).put('/admin/api/config').send({ auth: { enabled: true, keyBytes: 32 } })
    expect(first.status).toBe(200)
    expect(store.get().auth).toEqual({ enabled: true, keyBytes: 32, cleanupRetentionDays: 7 })

    // 只改 server（不带 auth 键）：既有 auth 值必须原样保留，不能被 prefault 默认值重置
    const second = await request(app).put('/admin/api/config').send({ server: { port: 8080 } })
    expect(second.status).toBe(200)
    expect(store.get().auth).toEqual({ enabled: true, keyBytes: 32, cleanupRetentionDays: 7 })
    expect(store.get().server?.port).toBe(8080)
  })

  it('三节同时提供：restartRequired 为 [server, routing]（auth 永不列入），落盘内容完整正确', async () => {
    const res = await request(app)
      .put('/admin/api/config')
      .send({
        server: { port: 9000 },
        routing: { sessionAffinity: { cleanupIntervalMs: 0 } },
        auth: { enabled: true },
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.restartRequired).toEqual(['server', 'routing'])
    // 落盘文件为完整配置：upstreams/downstreamModels 不受影响，三节按默认补齐
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8')) as OnDiskConfig
    expect(onDisk).toEqual({
      upstreams: BASE_CONFIG.upstreams,
      downstreamModels: BASE_CONFIG.downstreamModels,
      server: { host: '127.0.0.1', port: 9000, bodyLimit: '10mb' },
      routing: { sessionAffinity: { enabled: true, cleanupMaxAgeMs: 604800000, cleanupIntervalMs: 0 } },
      auth: { enabled: true, keyBytes: 24, cleanupRetentionDays: 7 },
    })
  })

  it('空 body 不修改任何值：200 + restartRequired 空 + 文件内容不变', async () => {
    const before = readFileSync(cfgPath, 'utf-8')
    const res = await request(app).put('/admin/api/config').send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.restartRequired).toEqual([])
    expect(res.body.config).toEqual({})
    // store.set 的 deepEqual 早退：无写盘动作，文件字节不变
    expect(readFileSync(cfgPath, 'utf-8')).toBe(before)
  })

  it('请求体中的未知顶层键被忽略（不校验、不写回）', async () => {
    const res = await request(app)
      .put('/admin/api/config')
      .send({ server: { port: 8080 }, upstreams: [] as unknown[] })
    expect(res.status).toBe(200)
    expect(res.body.restartRequired).toEqual(['server'])
    // upstreams 原样保留（未知键被 pick 过滤，未触碰）
    expect(store.get().upstreams).toHaveLength(1)
    expect(store.get().upstreams[0].id).toBe('u1')
  })
})

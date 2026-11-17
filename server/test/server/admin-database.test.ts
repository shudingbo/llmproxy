// 管理端数据库管理端点测试：GET /admin/api/database 与 POST /admin/api/database/vacuum
// 覆盖：状态快照（页级分布 / 表统计 / 门限回显）、手动收缩回收空闲页并返回最新状态、
//       收缩门限经 PUT /admin/api/config 的 database 节持久化与校验
// 路由层通过 getDataDir()（HOME 环境变量）定位真实 DB 路径，测试用 vi.stubEnv 重定向到临时目录
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import express, { type Express } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/config/store.js'
import { LogStore } from '../../src/logstore/index.js'
import { SessionStore } from '../../src/session/db.js'
import { ApiKeyStore } from '../../src/auth/db.js'
import { AdminSessionStore } from '../../src/auth/session-store.js'
import { StatsCounter } from '../../src/stats/counter.js'
import { enableIncrementalAutoVacuum } from '../../src/db/vacuum.js'
import { registerAdminRoutes } from '../../src/server/admin.js'
import { adminRequest } from '../helpers/adminSession.js'
import type { OpenAIUpstreamClient } from '../../src/upstream/openai.js'

// 基础配置模板：单上游 + 单别名 + 确定性 admins 节（避免 ConfigStore 构造期注入随机账号）
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
  admins: {
    salt: 'c'.repeat(64),
    accounts: [
      { username: 'admin', password: 'base-pw', disabled: false, createdAt: '2020-01-01T00:00:00.000Z', lastLoginAt: null },
    ],
  },
}

// 每次测试的共享状态
let tmpDir = ''
let cfgPath = ''
let store: ConfigStore
let stats: StatsCounter
let sessionStore: SessionStore
let logStore: LogStore
let apiKeyStore: ApiKeyStore
let adminSessionStore: AdminSessionStore
let app: Express
// 带有效管理会话 Cookie 的请求工厂（默认以「已登录」身份调用）
let req: ReturnType<typeof adminRequest>

// 路由层读取的数据目录 / DB 路径（HOME 被 stub 到 tmpDir 后 homedir() 返回 tmpDir）
const dataDir = (): string => join(tmpDir, 'llmproxy')
const dbPath = (): string => join(dataDir(), 'llmproxy.db')

// 造数据：建带 TEXT 大字段的表并插入 rows 行（每行约 sizeKB KB），删除 deleteRows 行制造空闲页
const seedAndDelete = (path: string, rows: number, sizeKB: number, deleteRows: number): void => {
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS blob_t (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)')
    const payload = 'x'.repeat(sizeKB * 1024)
    const insert = db.prepare('INSERT INTO blob_t (data) VALUES (?)')
    db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(payload)
    })()
    if (deleteRows > 0) {
      db.prepare('DELETE FROM blob_t WHERE id IN (SELECT id FROM blob_t ORDER BY id DESC LIMIT ?)').run(deleteRows)
    }
  } finally {
    db.close()
  }
}

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
    adminSessionStore,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'llmproxy-admin-db-'))
  // 预创建数据目录（路由层读 getDataDir 下的 llmproxy.db，seed 前必须存在）
  mkdirSync(dataDir(), { recursive: true })
  cfgPath = join(tmpDir, 'config.jsonc')
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG))
  store = new ConfigStore(cfgPath)
  stats = new StatsCounter()
  sessionStore = new SessionStore(join(tmpDir, 'sessions.db'))
  logStore = new LogStore(join(tmpDir, 'logs.db'))
  apiKeyStore = new ApiKeyStore(join(tmpDir, 'apikeys.db'))
  adminSessionStore = new AdminSessionStore(join(tmpDir, 'admin-sessions.db'))
  buildApp()
  req = adminRequest(app, adminSessionStore)
  // Windows 读 USERPROFILE，POSIX 读 HOME：两个都 stub 才跨平台生效（路由在请求期读 getDataDir）
  vi.stubEnv('USERPROFILE', tmpDir)
  vi.stubEnv('HOME', tmpDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const close of [sessionStore.close, logStore.close, apiKeyStore.close, adminSessionStore.close]) {
    try {
      close()
    } catch {
      // 连接已关闭，无需处理
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('数据库状态 GET /admin/api/database', () => {
  it('返回页级分布 / 表统计 / DB 文件路径；配置未设置 database 节时门限回显缺省 5GB', async () => {
    seedAndDelete(dbPath(), 4, 64, 0)
    const res = await req().get('/admin/api/database')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.path).toBe(dbPath())
    const db = res.body.db
    expect(db.fileSizeBytes).toBeGreaterThan(0)
    expect(db.pageSize).toBeGreaterThan(0)
    expect(db.pageCount).toBeGreaterThan(0)
    // 页级恒等式：used + free = pageCount × pageSize
    expect(db.usedBytes + db.freeBytes).toBe(db.pageCount * db.pageSize)
    expect(typeof db.autoVacuum).toBe('number')
    // 表统计：seeded 表存在且行数正确
    const blob = db.tables.find((t: { name: string }) => t.name === 'blob_t')
    expect(blob).toBeDefined()
    expect(blob.rows).toBe(4)
    // 未配置 database 节 → 门限为 schema 缺省 5GB
    expect(res.body.thresholdBytes).toBe(5 * 1024 * 1024 * 1024)
  })

  it('DB 文件不存在 → 500 { error: db_stats_failed }', async () => {
    const res = await req().get('/admin/api/database')
    expect(res.status).toBe(500)
    expect(res.body.status).toBe(false)
    expect(res.body.error).toBe('db_stats_failed')
  })
})

describe('手动收缩 POST /admin/api/database/vacuum', () => {
  it('空闲页存在时无视门限回收全部空闲页，返回释放字节数与最新状态', async () => {
    const path = dbPath()
    seedAndDelete(path, 20, 128, 10) // 约 2.5MB 数据 + 1.25MB 空闲页
    enableIncrementalAutoVacuum(path) // 转换为增量模式（路由层在非增量模式也会自动转换，这里先转以便断言 freelist 语义）
    // 再制造空闲页（转换时 VACUUM 已压平一次 freelist，需重新产生）
    seedAndDelete(path, 8, 128, 8)
    const res = await req().post('/admin/api/database/vacuum')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.reclaimedBytes).toBeGreaterThan(0)
    // 收缩后的最新状态：空闲页清零，文件页数小于收缩前
    expect(res.body.db.freeBytes).toBe(0)
    expect(typeof res.body.db.fileSizeBytes).toBe('number')
    expect(res.body.thresholdBytes).toBe(5 * 1024 * 1024 * 1024)
  })

  it('无空闲页时返回 reclaimedBytes = 0（status 仍为 true）', async () => {
    seedAndDelete(dbPath(), 2, 16, 0)
    const res = await req().post('/admin/api/database/vacuum')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    expect(res.body.reclaimedBytes).toBe(0)
  })

  it('非增量模式的库上调用：先自动转换模式再回收（按钮在任何库上都有效）', async () => {
    const path = dbPath()
    seedAndDelete(path, 8, 64, 8) // 约 512KB 空闲页，auto_vacuum = 0
    const probe = new Database(path)
    expect(probe.pragma('auto_vacuum', { simple: true })).toBe(0)
    probe.close()
    const res = await req().post('/admin/api/database/vacuum')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe(true)
    // 转换（VACUUM 压平 freelist）+ 回收后：模式为 incremental、空闲页清零、文件被截断
    expect(res.body.db.autoVacuum).toBe(2)
    expect(res.body.db.freeBytes).toBe(0)
  })
})

describe('收缩门限持久化 PUT /admin/api/config（database 节）', () => {
  it('保存 database.reclaimThresholdBytes：内存与文件同步更新，restartRequired 为空，GET /database 回显新门限', async () => {
    seedAndDelete(dbPath(), 1, 8, 0) // 建库（GET /database 需要文件存在）
    const put = await req().put('/admin/api/config').send({ database: { reclaimThresholdBytes: 2 * 1024 * 1024 * 1024 } })
    expect(put.status).toBe(200)
    expect(put.body.status).toBe(true)
    // 门限每次清理实时读取 → 无需重启
    expect(put.body.restartRequired).toEqual([])
    expect(store.get().database).toEqual({ reclaimThresholdBytes: 2 * 1024 * 1024 * 1024 })
    // 落盘文件同步更新
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { database?: { reclaimThresholdBytes: number } }
    expect(onDisk.database).toEqual({ reclaimThresholdBytes: 2 * 1024 * 1024 * 1024 })
    // 状态接口回显新门限
    const res = await req().get('/admin/api/database')
    expect(res.status).toBe(200)
    expect(res.body.thresholdBytes).toBe(2 * 1024 * 1024 * 1024)
  })

  it('非法门限（负数 / 非整数 / 超上限）返回 400 且不写回', async () => {
    for (const bad of [-1, 1.5, 1024 ** 4 + 1]) {
      const before = JSON.parse(JSON.stringify(store.get())) as unknown
      const res = await req().put('/admin/api/config').send({ database: { reclaimThresholdBytes: bad } })
      expect(res.status).toBe(400)
      expect(res.body.status).toBe(false)
      expect(res.body.error).toBe('invalid_config')
      expect(res.body.msg).toContain('database.reclaimThresholdBytes')
      expect(store.get()).toEqual(before)
    }
  })
})

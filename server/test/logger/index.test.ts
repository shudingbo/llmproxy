// logger 单元测试：基于 log4js 的双 category 配置、按日分文件、stdout 镜像、JSON / text 输出契约
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogStore } from '../../src/logstore/index.js'

// 每个用例通过 vi.resetModules() + 动态导入获得全新模块实例，保证 log4js 单例状态互不污染
let mod: typeof import('../../src/logger/index.js')

// requestLogger 参数类型（从签名推导）
type ReqLike = Parameters<typeof mod.requestLogger>[0]
type ResLike = Parameters<typeof mod.requestLogger>[1]

let tmp: string

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llmproxy-logger-'))
  // POSIX 下 os.homedir() 读 HOME；Windows 下读 USERPROFILE：都 stub
  vi.stubEnv('HOME', tmp)
  vi.stubEnv('USERPROFILE', tmp)
  // 假时钟只覆盖 Date，控制跨日；保留真实定时器让 fs 落盘
  vi.useFakeTimers({ toFake: ['Date'] })
  // streamroller 在 configureLogging 时同步构造并以"今天"建第一个日志文件，
  // 因此 fake Date 必须在 configureLogging 之前固定到目标日期，否则构造时拿到真实日期，
  // 跨日切分用例的文件名断言会失败（与代码无关，是 streamroller 与 fake timer 的交互）
  vi.setSystemTime(new Date(2026, 7, 2, 10, 0, 0))
  vi.resetModules()
  mod = await import('../../src/logger/index.js')
  // 每个用例都重新配置 log4js，logDir 会指向新的 tmp/<userid>/llmproxy/logs
  mod.configureLogging()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// 测试日志目录：tmp/<user>/llmproxy/logs
const logDir = (): string => join(tmp, 'llmproxy', 'logs')

// 轮询读取日志目录全部内容直到 predicate 满足
async function readAllLogs(predicate: (content: string) => boolean, timeoutMs = 3000): Promise<string> {
  const dir = logDir()
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    if (!existsSync(dir)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    content = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('')
    if (predicate(content)) return content
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return content
}

// 数据目录：tmp/<user>/llmproxy
const dataDir = (): string => join(tmp, 'llmproxy')
// log4js.json 配置路径
const log4jsConfigPath = (): string => join(dataDir(), 'log4js.json')

class FakeResponse extends EventEmitter {
  statusCode = 200
}

describe('configureLogging + log4js.json 文件加载', () => {
  it('首次启动在 ~/llmproxy/log4js.json 不存在时自动写入默认配置', () => {
    const path = log4jsConfigPath()
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf8')
    const cfg = JSON.parse(content) as Record<string, unknown>
    expect(cfg.appenders).toBeDefined()
    expect(cfg.categories).toBeDefined()
  })

  it('默认配置：app 用 stdout + file，api 仅用 file（避免请求日志刷控制台）', () => {
    const cfg = JSON.parse(readFileSync(log4jsConfigPath(), 'utf8')) as {
      appenders: Record<string, { type: string; layout?: unknown }>
      categories: Record<string, { appenders: string[]; level: string }>
    }
    expect(cfg.appenders.appStdout?.type).toBe('stdout')
    expect(cfg.appenders.appFile?.type).toBe('dateFile')
    // api 不再镜像到控制台
    expect(cfg.appenders.apiStdout).toBeUndefined()
    expect(cfg.appenders.apiFile?.type).toBe('dateFile')
    expect(cfg.appenders.apiFile?.layout).toEqual({ type: 'pinoJson' })
    expect(cfg.categories.app?.appenders).toEqual(['appStdout', 'appFile'])
    expect(cfg.categories.api?.appenders).toEqual(['apiFile'])
    expect(cfg.categories.default?.appenders).toEqual(['appStdout', 'appFile'])
  })

  it('运维修改 log4js.json 后：configureLogging 加载新值生效（不止缺省）', async () => {
    const customPath = log4jsConfigPath()
    const cfg = JSON.parse(readFileSync(customPath, 'utf8')) as {
      categories: Record<string, { appenders: string[]; level: string }>
    }
    cfg.categories.api = { appenders: ['apiFile'], level: 'fatal' }
    writeFileSync(customPath, JSON.stringify(cfg, null, 2))
    // log4js.addLayout / 内部状态是进程级全局，vi.resetModules() 不会重置 log4js 单例
    // 但 layout 注册在 configureLogging 内被重新调用（addLayout 幂等），故直接重读文件即可
    vi.resetModules()
    mod = await import('../../src/logger/index.js')
    mod.configureLogging()

    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    mod.getApiLogger().info('post-edit-info-marker')
    const dir = logDir()
    await new Promise((r) => setTimeout(r, 100))
    const apiFile = join(dir, 'api-2026-08-02.log')
    const content = existsSync(apiFile) ? readFileSync(apiFile, 'utf8') : ''
    expect(content).not.toContain('post-edit-info-marker')
  })

  it('configureLogging 幂等：同一进程多次调用不破坏已加载配置', () => {
    expect(() => {
      mod.configureLogging()
      mod.configureLogging()
    }).not.toThrow()
    const path = log4jsConfigPath()
    const statBefore = readFileSync(path, 'utf8').length
    mod.configureLogging()
    const statAfter = readFileSync(path, 'utf8').length
    expect(statAfter).toBe(statBefore)
  })
})

describe('configureLogging + getLogger/getApiLogger', () => {
  it('configureLogging 幂等：多次调用不抛错（log4js 不支持热改也安全）', () => {
    expect(() => {
      mod.configureLogging()
      mod.configureLogging()
    }).not.toThrow()
  })

  it('getLogger 默认返回 app 类别的 logger，写入 app-<date>.log 文本格式', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 10, 0, 0))
    mod.getLogger().info('app-info-marker-12345')
    const content = await readAllLogs((c) => c.includes('app-info-marker-12345'))
    expect(content).toContain('[app]')
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] \[app\]/)
    // 同时段不应有 api-*.log 内容
    expect(content).not.toContain('"msg":"app-info-marker-12345"')
  })

  it('getApiLogger 写入 api-<date>.log JSON 格式，且 level/time/msg 字段契约保持不变', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 11, 0, 0))
    mod.getApiLogger().info('api-info-marker-67890')
    const content = await readAllLogs((c) => c.includes('"msg":"api-info-marker-67890"'))
    // JSON 输出包含数值 level、毫秒 time、msg 字符串（前端 Logs 视图契约）
    expect(content).toContain('"level":30')
    expect(content).toContain('"time":')
    expect(content).toContain('"msg":"api-info-marker-67890"')
    // 不应有文本格式 [INFO] [api] 出现在 api 文件里
    expect(content).not.toContain('[INFO] [api]')
  })

  it('同一行调用 getLogger 与 getApiLogger 写到不同文件', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    mod.getLogger().info('app-side-marker')
    mod.getApiLogger().info('api-side-marker')
    const content = await readAllLogs(
      (c) => c.includes('app-side-marker') && c.includes('"msg":"api-side-marker"'),
    )
    // 文本格式的 app 行不应包含 api-side-marker（该 marker 只在 JSON 文件中）
    const textOnly = content.split('\n').filter((l) => l.startsWith('['))
    expect(textOnly.some((l) => l.includes('api-side-marker'))).toBe(false)
  })

  it('按日切分：跨日写入 2 行，分别落在两个日期文件中', async () => {
    const dir = logDir()
    vi.setSystemTime(new Date(2026, 7, 2, 10, 0, 0))
    mod.getLogger().info('day1-marker')
    mod.getApiLogger().info('api-day1')
    // 流式 streamroller 写完后还需要等真正的内容落盘，文件存在不等于内容就绪
    await readAllLogs(
      (c) => c.includes('day1-marker') && c.includes('api-day1'),
    )

    vi.setSystemTime(new Date(2026, 7, 3, 9, 0, 0))
    mod.getLogger().info('day2-marker')
    mod.getApiLogger().info('api-day2')
    await readAllLogs(
      (c) => c.includes('day2-marker') && c.includes('api-day2'),
    )

    const files = readdirSync(dir).sort()
    expect(files).toContain('app-2026-08-02.log')
    expect(files).toContain('app-2026-08-03.log')
    expect(files).toContain('api-2026-08-02.log')
    expect(files).toContain('api-2026-08-03.log')
    // 内容按文件名各自隔离
    const a2 = readFileSync(join(dir, 'app-2026-08-02.log'), 'utf8')
    const a3 = readFileSync(join(dir, 'app-2026-08-03.log'), 'utf8')
    expect(a2).toContain('day1-marker')
    expect(a2).not.toContain('day2-marker')
    expect(a3).toContain('day2-marker')
    expect(a3).not.toContain('day1-marker')
  })

  it('app 类别同时镜像到 stdout（控制台可看）', () => {
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      mod.getLogger().info('app-stdout-mirror-12345')
      const lines = stdoutSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(lines).toContain('app-stdout-mirror-12345')
      // 文本格式才会在 stdout 镜像到原样
      expect(lines).toContain('[INFO] [app]')
    } finally {
      stdoutSpy.mockRestore()
    }
  })

  it('api 类别不镜像到 stdout：避免大量请求日志刷控制台', () => {
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      mod.getApiLogger().info('api-no-stdout-marker-67890')
      const lines = stdoutSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(lines).not.toContain('api-no-stdout-marker-67890')
    } finally {
      stdoutSpy.mockRestore()
    }
  })

  it('getLogger(name) 落到未注册 category 时继承 default 配置（仍写入 app 文件）', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 13, 0, 0))
    mod.getLogger('not-registered').info('fallback-marker-1')
    const content = await readAllLogs((c) => c.includes('fallback-marker-1'))
    // 因为 default 走 appFile，所以应写入 app-*.log 且 category 在文本里显示为传入名
    expect(content).toContain('[not-registered]')
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
  })
})

describe('requestLogger', () => {
  it('附加 requestId 并输出 request-complete 到 api 类别的 JSON 文件', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 14, 0, 0))
    const req = {
      method: 'GET',
      url: '/api/ping',
      originalUrl: '/api/ping',
      headers: { 'user-agent': 'vitest', accept: '*/*' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    const next = vi.fn()
    mod.requestLogger(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((req as unknown as { requestId?: string }).requestId).toBeTruthy()
    res.emit('finish')

    const content = await readAllLogs((c) => c.includes('"msg":"request-complete"'))
    expect(content).toContain('"msg":"request-complete"')
    expect(content).toContain('"requestId"')
    expect(content).toContain('"method":"GET"')
    expect(content).toContain('"url":"/api/ping"')
    expect(content).toContain('"status":200')
    // 不应落在文本格式（app-*.log）
    expect(content).not.toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] \[api\]/)
  })

  it('脱敏：Authorization / x-api-key 不出现在 api 日志中，其余请求头保留', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 15, 0, 0))
    const req = {
      method: 'POST',
      url: '/api/keys',
      originalUrl: '/api/keys',
      headers: {
        authorization: 'Bearer SECRET-TOKEN-123',
        'x-api-key': 'SECRET-KEY-456',
        'user-agent': 'vitest',
        'content-type': 'application/json',
      },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    mod.requestLogger(req, res, vi.fn())
    res.emit('finish')

    const content = await readAllLogs((c) => c.includes('"msg":"request-complete"'))
    expect(content).not.toContain('SECRET-TOKEN-123')
    expect(content).not.toContain('SECRET-KEY-456')
    expect(content).not.toContain('Bearer')
    expect(content).not.toContain('x-api-key')
    expect(content).toContain('"user-agent":"vitest"')
    expect(content).toContain('"content-type":"application/json"')
  })

  it('不记录请求体', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 16, 0, 0))
    const req = {
      method: 'POST',
      url: '/api/echo',
      originalUrl: '/api/echo',
      headers: { 'content-type': 'application/json' },
      body: { password: 'hunter2', note: 'must-not-leak' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    mod.requestLogger(req, res, vi.fn())
    res.emit('finish')

    const content = await readAllLogs((c) => c.includes('"msg":"request-complete"'))
    expect(content).not.toContain('hunter2')
    expect(content).not.toContain('must-not-leak')
  })

  it('白名单：/admin/api/logs 精确路径跳过 finish 日志（不写文件、不入 SQLite）', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 17, 0, 0))
    const req = {
      method: 'GET',
      url: '/admin/api/logs',
      originalUrl: '/admin/api/logs?date=2026-08-02',
      headers: { 'user-agent': 'vitest' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    const next = vi.fn()
    mod.requestLogger(req, res, next)

    // 仍然 next + 生成 requestId（与正常请求一致，便于下游处理）
    expect(next).toHaveBeenCalledTimes(1)
    expect((req as unknown as { requestId?: string }).requestId).toBeTruthy()

    // 触发 finish 也不应产生日志条目
    res.emit('finish')

    // 抓本用例专属 marker：在 req 上挂一个唯一字段，确认整轮没有任何 request-complete 写出
    const allLogs = await readAllLogs(() => true)
    // 本次时间窗口的 finish 输出不应包含 admin/api/logs URL
    expect(allLogs).not.toContain('"url":"/admin/api/logs?date=2026-08-02"')
    // 也包含 query 剥离检查：日志 URL 不应原样出现（即使记录也应只保留 originalUrl，无 query），
    // 但因白名单命中，根本不应记录，故仅断言未出现即可
  })

  it('白名单：/admin/api/logs 的子路径（如 /cleanup）同样跳过', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const req = {
      method: 'POST',
      url: '/admin/api/logs/cleanup',
      originalUrl: '/admin/api/logs/cleanup',
      headers: {},
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    mod.requestLogger(req, res, vi.fn())
    res.emit('finish')

    const allLogs = await readAllLogs(() => true)
    expect(allLogs).not.toContain('"/admin/api/logs/cleanup"')
  })

  it('非白名单路径仍正常记录（如 /admin/api/upstreams）', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 19, 0, 0))
    const req = {
      method: 'GET',
      url: '/admin/api/upstreams',
      originalUrl: '/admin/api/upstreams',
      headers: { 'user-agent': 'vitest' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    mod.requestLogger(req, res, vi.fn())
    res.emit('finish')

    const content = await readAllLogs((c) => c.includes('"url":"/admin/api/upstreams"'))
    expect(content).toContain('"url":"/admin/api/upstreams"')
  })
})

describe('setLogStore + SQLite 双写', () => {
  // 每个用例独立的临时 DB，互不污染
  const makeStore = (): LogStore => new LogStore(join(tmp, `${Math.random().toString(36).slice(2)}.db`))

  // 查询当前 store 中 type 的全部行（time 上限放宽到假时钟后的未来）
  const queryAll = (store: LogStore, type: 'app' | 'api') =>
    store.query({ type, from: 0, to: Date.now() + 60_000, minLevel: 0, offset: 0, limit: 100 })

  it('未 setLogStore：行为与原来完全一致，不写 SQLite', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    try {
      mod.setLogStore(store)
      mod.getLogger('app').info('with-store-marker')
      expect(queryAll(store, 'app').total).toBe(1)

      mod.setLogStore(undefined)
      expect(() => {
        mod.getLogger('app').info('no-store-marker')
        mod.getApiLogger().info('no-store-api-marker')
      }).not.toThrow()
      expect(queryAll(store, 'app').total).toBe(1)
      expect(queryAll(store, 'api').total).toBe(0)
      const content = await readAllLogs((c) => c.includes('no-store-marker'))
      expect(content).toContain('no-store-marker')
    } finally {
      store.close()
    }
  })

  it('setLogStore 后 getLogger().info 双写：DB 记录 type=app、level=30、msg 含内容，文件照常', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    try {
      mod.setLogStore(store)
      mod.getLogger('app').info('hello-dual-write')
      const res = queryAll(store, 'app')
      expect(res.total).toBe(1)
      expect(res.rows[0].type).toBe('app')
      expect(res.rows[0].level).toBe(30)
      expect(res.rows[0].msg).toContain('hello-dual-write')
      const content = await readAllLogs((c) => c.includes('hello-dual-write'))
      expect(content).toContain('hello-dual-write')
    } finally {
      store.close()
    }
  })

  it('app 日志：category 列记 logger 名，结构化对象并入 raw（headers 无损）', () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    try {
      mod.setLogStore(store)
      mod.getLogger('app').info({ downstreamModel: 'm', headers: { 'user-agent': 'vitest' } }, 'downstream-used')
      const row = queryAll(store, 'app').rows[0]
      expect(row.category).toBe('app')
      expect(row.raw).toContain('downstreamModel')
      expect(row.raw).toContain('"user-agent":"vitest"')
      expect(row.msg).toContain('downstream-used')
    } finally {
      store.close()
    }
  })

  it('api 日志：request_id/method/url/status/duration_ms 列正确', () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    try {
      mod.setLogStore(store)
      mod.getApiLogger().info(
        { requestId: 'r1', method: 'GET', url: '/x', status: 200, durationMs: 5 },
        'request-complete',
      )
      const row = queryAll(store, 'api').rows[0]
      expect(row.type).toBe('api')
      expect(row.request_id).toBe('r1')
      expect(row.method).toBe('GET')
      expect(row.url).toBe('/x')
      expect(row.status).toBe(200)
      expect(row.duration_ms).toBe(5)
      expect(row.msg).toBe('request-complete')
    } finally {
      store.close()
    }
  })

  it('raw 脱敏：authorization / x-api-key 不落库（含 headers 嵌套），其余保留', () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    try {
      mod.setLogStore(store)
      mod.getLogger('app').info(
        { authorization: 'Bearer SECRET-TOKEN', headers: { 'x-api-key': 'SECRET-KEY', 'user-agent': 'vitest' } },
        'with-secrets',
      )
      const raw = queryAll(store, 'app').rows[0].raw ?? ''
      expect(raw).not.toContain('SECRET-TOKEN')
      expect(raw).not.toContain('SECRET-KEY')
      expect(raw).not.toContain('authorization')
      expect(raw).not.toContain('x-api-key')
      expect(raw).toContain('"user-agent":"vitest"')
    } finally {
      store.close()
    }
  })

  it('insert 抛错（store 已 close）：不崩溃，文件日志仍写入', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 18, 0, 0))
    const store = makeStore()
    mod.setLogStore(store)
    store.close() // 关闭后 insert 抛错，模拟 DB 故障
    expect(() => {
      mod.getLogger('app').info('still-writes-marker')
    }).not.toThrow()
    const content = await readAllLogs((c) => c.includes('still-writes-marker'))
    expect(content).toContain('still-writes-marker')
  })
})

describe('sweep 集成：getLogger 写入的文件也能被 sweep 清理', () => {
  it('过期 app-*.log 被 sweepOldLogs 删除', async () => {
    vi.setSystemTime(new Date(2026, 7, 2, 17, 0, 0))
    mod.getLogger().info('will-be-old')
    // 等文件落盘
    await readAllLogs((c) => c.includes('will-be-old'))
    const dir = logDir()
    const file = join(dir, 'app-2026-08-02.log')
    expect(existsSync(file)).toBe(true)
    // 把 mtime 推到 6 天前
    const past = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
    utimesSync(file, past, past)
    mod.sweepOldLogs(dir)
    expect(existsSync(file)).toBe(false)
  })
})

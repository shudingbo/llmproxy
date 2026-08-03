// logger 单元测试：按日分文件、日期翻转、请求日志脱敏、stdout 镜像
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 每个用例通过 vi.resetModules() + 动态导入获得全新模块实例，保证单例状态互不污染
let mod: typeof import('./index.js')

// 日志中间件参数类型（从 requestLogger 签名推导，避免重复声明）
type ReqLike = Parameters<typeof mod.requestLogger>[0]
type ResLike = Parameters<typeof mod.requestLogger>[1]

// 每个用例独立的临时数据目录（<tmp>/llmproxy/logs 为日志目录）
let tmp: string

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llmproxy-logger-'))
  // POSIX 下 os.homedir() 读 HOME；Windows 下优先读 USERPROFILE，两者都 stub
  vi.stubEnv('HOME', tmp)
  vi.stubEnv('USERPROFILE', tmp)
  // 假时钟仅覆盖 Date：控制 new Date() / Date.now() 模拟跨日；保留真实定时器供轮询等待 fs 落盘
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.resetModules()
  mod = await import('./index.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// 日志目录完整路径
const logDir = (): string => join(tmp, 'llmproxy', 'logs')

// 轮询读取日志目录全部内容直到满足 predicate：
// pino 目标流是异步写（sync: false），flushSync 无法追回在途的 fs.write，读取前需等待落盘
async function readAllLogs(dir: string, predicate: (content: string) => boolean, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('')
    if (predicate(content)) return content
    // 真实定时器（fake 仅覆盖 Date），让出事件循环等待 fs 回调完成
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return content
}

// 极简的响应替身：支持 on('finish') 监听与状态码
class FakeResponse extends EventEmitter {
  statusCode = 200
}

describe('getLogger 按日分文件', () => {
  it('跨日写入 3 行，生成 2 个正确命名的文件且内容各归其位', async () => {
    const { getLogger, flushLoggerSync } = mod
    // 第一天写 2 行
    vi.setSystemTime(new Date(2026, 7, 2, 10, 0, 0))
    getLogger().info('第一行-第一天')
    getLogger().info({ extra: 1 }, '第二行-第一天')
    // 第二天写 1 行
    vi.setSystemTime(new Date(2026, 7, 3, 9, 0, 0))
    getLogger().info('第三行-第二天')
    flushLoggerSync()

    // 等待两天的日志都落盘
    await readAllLogs(logDir(), (c) => c.includes('第一行-第一天') && c.includes('第三行-第二天'))
    const files = readdirSync(logDir()).sort()
    expect(files).toEqual(['app-2026-08-02.log', 'app-2026-08-03.log'])
    const day1 = readFileSync(join(logDir(), 'app-2026-08-02.log'), 'utf8')
    const day2 = readFileSync(join(logDir(), 'app-2026-08-03.log'), 'utf8')
    expect(day1).toContain('第一行-第一天')
    expect(day1).toContain('第二行-第一天')
    expect(day2).toContain('第三行-第二天')
    // 内容不串文件
    expect(day1).not.toContain('第三行-第二天')
    expect(day2).not.toContain('第一行-第一天')
  })

  it('getLogger 返回同一单例', () => {
    const { getLogger } = mod
    expect(getLogger()).toBe(getLogger())
  })

  it('每条日志同步镜像到 process.stdout（控制台也能看到）', () => {
    const { getLogger, flushLoggerSync } = mod
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      getLogger().info('stdout-mirror-marker-12345')
      flushLoggerSync()
      const lines = stdoutSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(lines).toContain('"msg":"stdout-mirror-marker-12345"')
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

describe('requestLogger', () => {
  it('附加 requestId 并输出 request-complete 日志', async () => {
    const { flushLoggerSync, requestLogger } = mod
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    const req = {
      method: 'GET',
      url: '/api/ping',
      originalUrl: '/api/ping',
      headers: { 'user-agent': 'vitest', accept: '*/*' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    const next = vi.fn()
    requestLogger(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((req as unknown as { requestId?: string }).requestId).toBeTruthy()
    res.emit('finish')
    flushLoggerSync()

    const content = await readAllLogs(logDir(), (c) => c.includes('request-complete'))
    expect(content).toContain('request-complete')
    expect(content).toContain('"requestId"')
    expect(content).toContain('/api/ping')
    expect(content).toContain('"status":200')
  })

  it('脱敏：Authorization / x-api-key 的密钥不出现在日志中，其余请求头保留', async () => {
    const { flushLoggerSync, requestLogger } = mod
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
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
    requestLogger(req, res, vi.fn())
    res.emit('finish')
    flushLoggerSync()

    const content = await readAllLogs(logDir(), (c) => c.includes('request-complete'))
    // 密钥及其字段名一律不得出现
    expect(content).not.toContain('SECRET-TOKEN-123')
    expect(content).not.toContain('SECRET-KEY-456')
    expect(content).not.toContain('Bearer')
    expect(content).not.toContain('x-api-key')
    // 允许保留的请求头照常记录
    expect(content).toContain('"user-agent":"vitest"')
    expect(content).toContain('"content-type":"application/json"')
  })

  it('不记录请求体', async () => {
    const { flushLoggerSync, requestLogger } = mod
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0))
    const req = {
      method: 'POST',
      url: '/api/echo',
      originalUrl: '/api/echo',
      headers: { 'content-type': 'application/json' },
      body: { password: 'hunter2', note: 'must-not-leak' },
    } as unknown as ReqLike
    const res = new FakeResponse() as unknown as ResLike
    requestLogger(req, res, vi.fn())
    res.emit('finish')
    flushLoggerSync()

    const content = await readAllLogs(logDir(), (c) => c.includes('request-complete'))
    expect(content).not.toContain('hunter2')
    expect(content).not.toContain('must-not-leak')
  })
})

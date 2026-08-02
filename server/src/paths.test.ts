// paths 单元测试：验证数据目录引导、路径推导与本地日期格式化
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConfigPath, getDataDir, getLocalDateString, getLogDir, getLogFilePath } from './paths.js'

// 每个用例使用独立临时目录，避免污染真实用户目录
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llmproxy-test-'))
  // POSIX 下 os.homedir() 读 HOME；Windows 下优先读 USERPROFILE，两者都 stub
  vi.stubEnv('HOME', tmp)
  vi.stubEnv('USERPROFILE', tmp)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getDataDir', () => {
  it('返回以 llmproxy 结尾的路径', () => {
    expect(getDataDir()).toBe(join(tmp, 'llmproxy'))
  })

  it('首次调用会创建目录（mode 0o700；Windows 跳过严格权限校验）', () => {
    const dir = getDataDir()
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
    // Windows 下 0o700 体现为 ACL 保护而非 POSIX 权限位，模式不可靠，跳过
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  it('重复调用幂等，不抛错', () => {
    getDataDir()
    expect(() => getDataDir()).not.toThrow()
  })
})

describe('配置与日志路径', () => {
  it('getConfigPath 返回 <dataDir>/llmproxy.jsonc', () => {
    expect(getConfigPath()).toBe(join(tmp, 'llmproxy', 'llmproxy.jsonc'))
  })

  it('getLogDir 返回 <dataDir>/logs 并创建目录', () => {
    const dir = getLogDir()
    expect(dir).toBe(join(tmp, 'llmproxy', 'logs'))
    expect(existsSync(dir)).toBe(true)
  })

  it('getLogFilePath 返回 app-YYYY-MM-DD.log（按本地时区）', () => {
    const date = new Date('2026-08-02T15:00:00Z')
    const file = getLogFilePath(date)
    // 本地时区决定具体日期，因此期望值由同一本地日期函数推导
    expect(file).toBe(join(tmp, 'llmproxy', 'logs', `app-${getLocalDateString(date)}.log`))
  })
})

describe('getLocalDateString', () => {
  it('返回 YYYY-MM-DD 格式', () => {
    // 用本地时区构造日期，保证任何主机时区下断言都成立
    expect(getLocalDateString(new Date(2026, 7, 2, 12, 0, 0))).toBe('2026-08-02')
    expect(getLocalDateString(new Date(2026, 0, 9, 8, 30, 0))).toBe('2026-01-09')
    expect(getLocalDateString(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
  })

  it('输出符合 /^\\d{4}-\\d{2}-\\d{2}$/', () => {
    expect(getLocalDateString(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

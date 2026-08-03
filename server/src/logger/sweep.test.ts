// sweep 单元测试：保留期清理与自动清理入口
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLogRetention, stopLogRetention, sweepLogsBefore, sweepOldLogs } from './sweep.js'

// 每个用例独立的临时日志目录
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llmproxy-sweep-'))
})

afterEach(() => {
  // 清除自动清理定时器，避免跨用例残留
  stopLogRetention()
})

// 创建指定名称的日志文件，并把 mtime 设置为 daysAgo 天前
function touchLog(name: string, daysAgo: number): string {
  const file = join(tmp, name)
  writeFileSync(file, 'dummy')
  const mtime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  utimesSync(file, mtime, mtime)
  return file
}

describe('sweepOldLogs', () => {
  it('删除 6 天前的日志，保留 4 天前的日志', () => {
    const oldFile = touchLog('app-2026-07-27.log', 6)
    const freshFile = touchLog('app-2026-07-29.log', 4)
    expect(sweepOldLogs(tmp)).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
  })

  it('不处理非 app-*.log 文件', () => {
    const oldFile = touchLog('app-old.log', 10)
    const other = touchLog('service.log', 10)
    const notes = touchLog('app-notes.txt', 10)
    expect(sweepOldLogs(tmp)).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(notes)).toBe(true)
  })

  it('空目录返回 0', () => {
    expect(sweepOldLogs(tmp)).toBe(0)
  })

  it('返回删除的文件数量', () => {
    touchLog('app-a.log', 10)
    touchLog('app-b.log', 9)
    touchLog('app-c.log', 1)
    expect(sweepOldLogs(tmp)).toBe(2)
  })
})

describe('sweepLogsBefore', () => {
  it('删除 mtime 早于 beforeMs 的日志文件，保留更新的文件', () => {
    const oldFile = touchLog('app-old.log', 3)
    const freshFile = touchLog('app-fresh.log', 1)
    // beforeMs = 2 天前：3 天前的旧文件被删，1 天前的新文件保留
    const beforeMs = Date.now() - 2 * 24 * 60 * 60 * 1000
    expect(sweepLogsBefore(tmp, beforeMs)).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
  })

  it('api-*.log 同样按 mtime 清理；只删 app-*/api-* 不删其他文件', () => {
    const oldApi = touchLog('api-old.log', 5)
    const freshApi = touchLog('api-fresh.log', 1)
    const other = touchLog('service.log', 5)
    const notes = touchLog('api-notes.txt', 5)
    const beforeMs = Date.now() - 2 * 24 * 60 * 60 * 1000
    expect(sweepLogsBefore(tmp, beforeMs)).toBe(1)
    expect(existsSync(oldApi)).toBe(false)
    expect(existsSync(freshApi)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(notes)).toBe(true)
  })

  it('beforeMs 为当前时间时全删；空目录返回 0', () => {
    touchLog('app-a.log', 0.5)
    touchLog('app-b.log', 0.1)
    expect(sweepLogsBefore(tmp, Date.now())).toBe(2)
    expect(sweepLogsBefore(tmp, Date.now())).toBe(0)
  })
})

describe('initLogRetention', () => {
  it('立即执行一次清理并返回删除数量', () => {
    const oldFile = touchLog('app-2026-06-01.log', 20)
    expect(initLogRetention(tmp)).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
  })

  it('重复调用不重复创建定时器，可正常停止', () => {
    initLogRetention(tmp)
    initLogRetention(tmp)
    // 停止后定时器被清除，不再有残留句柄
    stopLogRetention()
    // 停止后清理能力依然可用
    touchLog('app-x.log', 8)
    expect(sweepOldLogs(tmp)).toBe(1)
  })
})

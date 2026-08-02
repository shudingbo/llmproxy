// sweep 单元测试：保留期清理与自动清理入口
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLogRetention, stopLogRetention, sweepOldLogs } from './sweep.js'

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

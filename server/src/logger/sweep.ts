// 日志保留期清理：删除超过保留天数的 app-*.log，支持启动时立即清理与定时自动清理
// 本模块保持纯净（不依赖 logger），避免与 index.ts 循环依赖
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// 日志保留天数
const RETENTION_DAYS = 5
// 自动清理间隔：6 小时（毫秒）
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

// 模块级定时器句柄；unref 保证不阻塞进程退出
let sweepTimer: NodeJS.Timeout | null = null

/**
 * 清理 dir 下超过保留期的 app-*.log 文件。
 * 判定标准：文件 mtime < 当前时间 - 5 天。返回删除的文件数量。
 */
export function sweepOldLogs(dir: string): number {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let deleted = 0
  for (const name of readdirSync(dir)) {
    // 只处理按日期命名的日志文件
    if (!name.startsWith('app-') || !name.endsWith('.log')) continue
    const filePath = join(dir, name)
    if (statSync(filePath).mtime.getTime() < cutoff) {
      unlinkSync(filePath)
      deleted++
    }
  }
  return deleted
}

/**
 * 启动日志保留期自动清理：立即执行一次，并每 6 小时执行一次。
 * 定时器 unref 化，不阻塞进程退出。返回首次清理删除的数量。
 */
export function initLogRetention(dir: string): number {
  const deleted = sweepOldLogs(dir)
  if (sweepTimer === null) {
    sweepTimer = setInterval(() => {
      sweepOldLogs(dir)
    }, SWEEP_INTERVAL_MS)
    // 不阻止进程退出
    sweepTimer.unref()
  }
  return deleted
}

/**
 * 停止自动清理定时器（测试用；生产环境进程退出时无需显式调用）。
 */
export function stopLogRetention(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

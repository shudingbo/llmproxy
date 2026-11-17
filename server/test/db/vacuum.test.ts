// vacuum 单元测试：增量 auto_vacuum 模式启用（幂等）/ 按门限回收空闲页 / 门限以下不动作 / 非增量模式不生效 /
// getDatabaseStats 状态快照
// 使用临时 DB 文件（tmpdir 下随机名），用例结束后删除 db/-wal/-shm 伴生文件
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enableIncrementalAutoVacuum, getDatabaseStats, reclaimFreeSpace } from '../../src/db/vacuum.js'

// 生成唯一临时 DB 路径：vacuum-test-<随机hex>.db
const makeTempDbPath = (): string => join(tmpdir(), `vacuum-test-${randomBytes(6).toString('hex')}.db`)

// 删除 DB 及 WAL/SHM 伴生文件（WAL 模式下同目录会产生 -wal / -shm）
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = dbPath + suffix
    if (existsSync(filePath)) {
      rmSync(filePath)
    }
  }
}

// 独立连接读文件级 pragma（page_count / freelist_count / auto_vacuum），用完即关
const readPragma = (dbPath: string, name: string): number => {
  const db = new Database(dbPath)
  try {
    return db.pragma(name, { simple: true }) as number
  } finally {
    db.close()
  }
}

// 造数据：建带 TEXT 大字段的表并插入 rows 行（每行约 sizeKB KB），删除 deleteRows 行制造空闲页
const seedAndDelete = (dbPath: string, rows: number, sizeKB: number, deleteRows: number): void => {
  const db = new Database(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS blob_t (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)')
    const payload = 'x'.repeat(sizeKB * 1024)
    const insert = db.prepare('INSERT INTO blob_t (data) VALUES (?)')
    db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(payload)
    })()
    if (deleteRows > 0) {
      // 删最近插入的 N 行（不用 id <= N：表里可能有前序数据，AUTOINCREMENT 起点不可预知）
      db.prepare('DELETE FROM blob_t WHERE id IN (SELECT id FROM blob_t ORDER BY id DESC LIMIT ?)').run(deleteRows)
    }
  } finally {
    db.close()
  }
}

describe('vacuum', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = makeTempDbPath()
  })

  afterEach(() => {
    removeDbFiles(dbPath)
  })

  it('enableIncrementalAutoVacuum：新库转换后 auto_vacuum 为 2（incremental），重复调用幂等', () => {
    seedAndDelete(dbPath, 5, 16, 0)
    enableIncrementalAutoVacuum(dbPath)
    expect(readPragma(dbPath, 'auto_vacuum')).toBe(2)
    // 幂等：再次调用不报错且模式保持
    enableIncrementalAutoVacuum(dbPath)
    expect(readPragma(dbPath, 'auto_vacuum')).toBe(2)
  })

  it('reclaimFreeSpace：空闲页超过门限 → 释放并截断文件；freelist 清零后再次调用返回 0', () => {
    seedAndDelete(dbPath, 40, 256, 20) // 插 10MB 删 5MB，空闲 5MB
    enableIncrementalAutoVacuum(dbPath) // 转换（此时 VACUUM 会先压平一次，freelist 归零）
    // 再制造空闲页：插入 6MB 再全删 → freelist ≈ 6MB > 门限（测试用 4MB 小门限）
    seedAndDelete(dbPath, 12, 512, 12)
    const pageCountBefore = readPragma(dbPath, 'page_count')
    const freed = reclaimFreeSpace(dbPath, 4 * 1024 * 1024)
    expect(freed).toBeGreaterThan(0)
    expect(readPragma(dbPath, 'freelist_count')).toBe(0)
    expect(readPragma(dbPath, 'page_count')).toBeLessThan(pageCountBefore)
    // 已无空闲页：再次调用返回 0
    expect(reclaimFreeSpace(dbPath, 4 * 1024 * 1024)).toBe(0)
  })

  it('reclaimFreeSpace：空闲页低于门限 → 返回 0 且文件不变', () => {
    enableIncrementalAutoVacuum(dbPath)
    seedAndDelete(dbPath, 4, 64, 4) // 制造约 256KB 空闲页
    const pageCountBefore = readPragma(dbPath, 'page_count')
    expect(reclaimFreeSpace(dbPath, 4 * 1024 * 1024)).toBe(0)
    expect(readPragma(dbPath, 'page_count')).toBe(pageCountBefore)
    expect(readPragma(dbPath, 'freelist_count')).toBeGreaterThan(0) // 空闲页保留待复用
  })

  it('reclaimFreeSpace：未启用增量模式 → 返回 0 且不回收', () => {
    seedAndDelete(dbPath, 20, 64, 20) // 约 1.25MB 空闲页
    const pageCountBefore = readPragma(dbPath, 'page_count')
    expect(readPragma(dbPath, 'auto_vacuum')).toBe(0)
    expect(reclaimFreeSpace(dbPath, 4 * 1024 * 1024)).toBe(0)
    expect(readPragma(dbPath, 'page_count')).toBe(pageCountBefore)
  })

  it('getDatabaseStats：页级分布与 auto_vacuum 模式正确，表统计含行数与占用', () => {
    seedAndDelete(dbPath, 10, 64, 4) // 约 640KB 数据 + 256KB 空闲页
    enableIncrementalAutoVacuum(dbPath)
    const stats = getDatabaseStats(dbPath)
    // 文件事实大小 > 0；auto_vacuum 已转为 incremental（2）
    expect(stats.fileSizeBytes).toBeGreaterThan(0)
    expect(stats.autoVacuum).toBe(2)
    // 页级恒等式：usedBytes = (page_count - freelist) × page_size，freeBytes = freelist × page_size
    const pageSize = readPragma(dbPath, 'page_size')
    const pageCount = readPragma(dbPath, 'page_count')
    const freePages = readPragma(dbPath, 'freelist_count')
    expect(stats.pageSize).toBe(pageSize)
    expect(stats.pageCount).toBe(pageCount)
    expect(stats.usedBytes).toBe((pageCount - freePages) * pageSize)
    expect(stats.freeBytes).toBe(freePages * pageSize)
    // 表统计：seeded 表存在、行数正确、dbstat 占用大于 0（better-sqlite3 prebuilds 含 dbstat）
    const blob = stats.tables.find((t) => t.name === 'blob_t')
    expect(blob).toBeDefined()
    expect(blob!.rows).toBe(6)
    expect(blob!.sizeBytes).toBeGreaterThan(0)
    // 占用降序：首条记录的占用不小于末条
    expect(stats.tables[0].sizeBytes).toBeGreaterThanOrEqual(stats.tables[stats.tables.length - 1].sizeBytes)
  })

  it('getDatabaseStats：DB 文件不存在时抛错（fileMustExist）', () => {
    expect(() => getDatabaseStats(join(tmpdir(), `vacuum-missing-${randomBytes(4).toString('hex')}.db`))).toThrow()
  })
})

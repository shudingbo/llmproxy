// SQLite 空间回收助手：解决「DELETE 只产生空闲页、文件永不收缩」的磁盘膨胀问题
// 背景：logs / session_messages / sessions 的保留期清理（每 6 小时）只删行不归还磁盘——
// SQLite 的 DELETE 把页挂入 freelist，文件大小不变；不 VACUUM 文件永远不缩。
// 方案：DB 文件启用 incremental auto_vacuum（一次性转换，文件级持久属性），
// 之后每次清理周期在空闲页超过门限时用 incremental_vacuum 把空闲页截断出文件。
// 服务影响说明：incremental_vacuum 是单个写事务——WAL 下读不阻塞，写会排队；
// 故按块执行（单事务最多 VACUUM_CHUNK_PAGES 页），块间允许业务写事务插队，最坏阻塞有界。
// 职责：只做原语（启用模式 / 按门限回收 / 状态统计），不碰业务表、不做调度（调度由调用方负责）
import { statSync } from 'node:fs'
import Database from 'better-sqlite3'

// 空闲页回收触发门限：freelist 累计超过 5GB 才回收（滞回语义——回收会清空整个 freelist，
// 之后要重新积累超 5GB 才会再次触发）。空闲页在下次写入时优先复用，低于门限的空闲完全无害，
// 频繁截断文件反而产生无谓的写事务，故门限取大值
export const RECLAIM_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024

// 单个写事务最多回收的页数（64MB @ 4KB 页）：控制 incremental_vacuum 单次持锁时长，
// 循环分块执行直到低于门限——块与块之间其他写事务可以插队，避免长时间独占写锁拖慢在途请求
const VACUUM_CHUNK_PAGES = 16 * 1024

/**
 * 把 DB 文件切换为增量自动回收模式（幂等）。
 * auto_vacuum 是文件级持久属性：已经是 INCREMENTAL（返回值 2）时直接返回；
 * 否则置标志后跑一次全量 VACUUM 完成转换（耗时与存活数据量成正比，空闲页不参与重建，
 * 历史上膨胀到 GB 级的库转换也只取决于真实数据大小）。转换后该文件永久保持增量模式。
 * 建议在进程启动、业务连接打开之前调用（装配层位于 createApp 开头，listen 之前，不影响在线服务）。
 * 独立短连接 + busy_timeout：不与业务连接争锁，等待既有写事务最多 5s。
 */
export function enableIncrementalAutoVacuum(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    const mode = db.pragma('auto_vacuum', { simple: true }) as number
    if (mode === 2) {
      return
    }
    // 非增量模式下仅置标志不生效，必须紧跟一次 VACUUM 才完成文件转换
    db.pragma('auto_vacuum = INCREMENTAL')
    db.exec('VACUUM')
  } finally {
    db.close()
  }
}

/**
 * 按门限回收空闲页：freelist 低于门限返回 0（不动文件）；
 * 高于门限时按块执行 incremental_vacuum 清空整个 freelist，返回释放的字节数。
 * 仅在 incremental auto_vacuum 模式下生效（非增量模式 freelist 不受控，返回 0）。
 * 独立短连接 + busy_timeout：可与其他业务连接并发（WAL 读写互不阻塞）。
 */
export function reclaimFreeSpace(dbPath: string, thresholdBytes: number): number {
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    const pageSize = db.pragma('page_size', { simple: true }) as number
    const freePages = db.pragma('freelist_count', { simple: true }) as number
    if (freePages * pageSize < thresholdBytes) {
      return 0
    }
    const beforeBytes = freePages * pageSize
    // 分块回收：每块单事务、最多 VACUUM_CHUNK_PAGES 页，块间让出写锁，直至 freelist 清空。
    // 注意 incremental_vacuum 是行返回型 pragma（每移一页返回一行）——不能用 {simple:true}
    // （只 step 一次 = 每次仅移 1 页），必须整句执行；模式未生效时无页可移，以 freelist 无进展为终止条件防空转
    let remainingPages = freePages
    for (;;) {
      db.pragma(`incremental_vacuum(${VACUUM_CHUNK_PAGES})`)
      const freePagesNow = db.pragma('freelist_count', { simple: true }) as number
      if (freePagesNow >= remainingPages) {
        break
      }
      remainingPages = freePagesNow
    }
    const remainingBytes = remainingPages * pageSize
    return beforeBytes - remainingBytes
  } finally {
    db.close()
  }
}

/** 单张用户表的统计：行数 + B-tree 实际占用字节（含该表的索引） */
export interface TableStat {
  name: string
  rows: number
  sizeBytes: number
}

/** 数据库状态快照：文件容量 / 页级分布 / auto_vacuum 模式 / 各表占用 */
export interface DatabaseStats {
  /** DB 主文件大小（字节，stat 事实值） */
  fileSizeBytes: number
  /** WAL 伴生文件大小（字节），不存在为 0 */
  walSizeBytes: number
  /** 页大小（字节，PRAGMA page_size） */
  pageSize: number
  /** 总页数（PRAGMA page_count） */
  pageCount: number
  /** 存活数据占用（(page_count - freelist) × page_size） */
  usedBytes: number
  /** 空闲页占用（freelist × page_size）——可被回收 / 复用的部分 */
  freeBytes: number
  /** auto_vacuum 模式：0 = none / 1 = full / 2 = incremental */
  autoVacuum: number
  /** 各用户表统计（按占用字节降序）；dbstat 虚表不可用时 sizeBytes 恒为 0 */
  tables: TableStat[]
}

/**
 * 读取数据库状态快照（只读连接，不产生写锁，可在线查询）：
 * - 页级信息来自 PRAGMA（page_size / page_count / freelist_count / auto_vacuum）
 * - 表级行数来自逐表 count(*)（sqlite_master 枚举用户表）；表占用来自 dbstat 虚表聚合，
 *   dbstat 不可用（编译选项 SQLITE_ENABLE_DBSTAT_VTAB 缺失）时降级为 sizeBytes = 0
 * - 文件大小走 stat：主文件 + WAL 伴生文件（WAL 尚未 checkpoint 的部分不计入 page_count）
 * DB 文件不存在时抛错（由调用方决定 500 语义）。
 */
export function getDatabaseStats(dbPath: string): DatabaseStats {
  // 文件事实大小：stat 主文件与 -wal（不存在则 0）
  const fileSizeBytes = statSync(dbPath).size
  let walSizeBytes = 0
  try {
    walSizeBytes = statSync(`${dbPath}-wal`).size
  } catch {
    // 无 WAL 文件（刚 checkpoint 过）属正常，视为 0
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const pageSize = db.pragma('page_size', { simple: true }) as number
    const pageCount = db.pragma('page_count', { simple: true }) as number
    const freePages = db.pragma('freelist_count', { simple: true }) as number
    const autoVacuum = db.pragma('auto_vacuum', { simple: true }) as number

    // 表占用（dbstat 聚合）：name → 占用页数之和；失败降级为空 Map（行数统计不受影响）
    const pageByTable = new Map<string, number>()
    try {
      const rows = db
        .prepare('SELECT name, sum(pgsize) AS pages FROM dbstat GROUP BY name')
        .all() as Array<{ name: string; pages: number }>
      for (const row of rows) {
        pageByTable.set(row.name, row.pages)
      }
    } catch {
      // dbstat 虚表缺失：仅表占用列不可用，状态页级信息仍完整
    }

    // 用户表枚举 + 行数：排除 sqlite_ 内部表；dbstat 的表条目（含索引 btree 名）在此天然对齐
    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name)
    const tables: TableStat[] = tableNames.map((name) => {
      const rows = (db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n
      return { name, rows, sizeBytes: (pageByTable.get(name) ?? 0) * pageSize }
    })
    // 占用大的表排前面，管理端列表一眼看到大头
    tables.sort((a, b) => b.sizeBytes - a.sizeBytes || b.rows - a.rows)

    return {
      fileSizeBytes,
      walSizeBytes,
      pageSize,
      pageCount,
      usedBytes: (pageCount - freePages) * pageSize,
      freeBytes: freePages * pageSize,
      autoVacuum,
      tables,
    }
  } finally {
    db.close()
  }
}

// 路径工具：统一管理 llmproxy 数据目录、配置文件与日志文件的定位
// 仅负责路径推导与目录引导，不涉及配置加载 / 日志写入（分别由 T5、T7 负责）
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 用户数据目录的相对名（挂在 os.homedir() 之下）
const DATA_DIR_NAME = 'llmproxy'
// 配置文件相对名（JSONC：支持注释与尾逗号）
const CONFIG_FILE_NAME = 'llmproxy.jsonc'
// 日志目录相对名
const LOG_DIR_NAME = 'logs'

// 本地日期格式化器：输出 YYYY-MM-DD（en-CA 恰好是该格式）
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * 返回用户数据目录 <homedir>/llmproxy，不存在时递归创建（mode 0o700）。
 * 幂等：重复调用不会抛错。
 */
export function getDataDir(): string {
  const dir = join(homedir(), DATA_DIR_NAME)
  // Windows 下 0o700 会转换为当前用户的 ACL 保护目录；POSIX 下为 rwx------
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 返回配置文件路径 <dataDir>/llmproxy.jsonc。
 */
export function getConfigPath(): string {
  return join(getDataDir(), CONFIG_FILE_NAME)
}

/**
 * 返回日志目录 <dataDir>/logs，不存在时创建。幂等。
 */
export function getLogDir(): string {
  const dir = join(getDataDir(), LOG_DIR_NAME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 返回某日期的日志文件路径 <logDir>/app-YYYY-MM-DD.log。
 * 日期按本地时区计算。
 */
export function getLogFilePath(date: Date): string {
  return join(getLogDir(), `app-${getLocalDateString(date)}.log`)
}

/**
 * 按本地时区把日期格式化为 YYYY-MM-DD 字符串。
 * 使用 Intl.DateTimeFormat（en-CA 地区格式恰好为 YYYY-MM-DD）。
 */
export function getLocalDateString(now: Date): string {
  return dateFormatter.format(now)
}

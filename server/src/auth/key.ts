// API Key 工具：随机生成、SHA-256 哈希、Authorization 头解析
// 不依赖 storage（key.ts vs db.ts 拆分：前者纯算法 / 后者 SQLite 持久化）
import { createHash, randomBytes } from 'node:crypto'

// API Key 前缀：与 OpenAI sk- 风格对齐，便于人工识别与 IDE 自动补全提示
export const API_KEY_PREFIX = 'sk-llmproxy-'

/**
 * 生成新的 API Key 字符串：
 * - 形如 "sk-llmproxy-<32 hex>"（keyBytes=24 → 32 字符 hex）
 * - randomBytes 走 CSPRNG，适合鉴权场景
 * - 生成 + 哈希分别给到调用方：明文一次性返回给用户，hash 入库
 */
export function generateApiKey(keyBytes: number = 24): string {
  // randomBytes 内部走 os CSPRNG，鉴权场景安全
  const hex = randomBytes(keyBytes).toString('hex')
  return `${API_KEY_PREFIX}${hex}`
}

/**
 * 对明文 Key 计算 SHA-256 摘要（hex 字符串，64 字符）：
 * - 单向，无法反推明文
 * - 存储层与鉴权层都用同一摘要函数，确保按 hash 查找能命中
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * 取明文 Key 的展示前缀（前 8 字符），存入 DB 用于 UI 识别：
 * - 例：'sk-llmp-abcd1234…' → 'sk-llmp'（前 8 字符）
 * - 不含完整 hex 段，避免明文 Key 碎片泄漏
 */
export function extractKeyPrefix(key: string): string {
  return key.slice(0, 8)
}

/**
 * 解析 Authorization 头：
 * - 支持大小写不敏感的 'Bearer' 前缀
 * - 仅返回剥离 Bearer 后的 token；无法识别返回 undefined
 *
 * 注：头名按 Express 规范化一律小写（headers.authorization / headers['authorization']）
 */
export function parseBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || header === '') {
    return undefined
  }
  const trimmed = header.trim()
  // 形如 "Bearer xxx" / "bearer xxx" / "BEARER xxx"
  const m = /^Bearer\s+(.+)$/i.exec(trimmed)
  if (m === null) {
    return undefined
  }
  const token = m[1].trim()
  return token === '' ? undefined : token
}
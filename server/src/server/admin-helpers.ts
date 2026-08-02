// 管理端辅助函数：API 密钥展示脱敏与敏感字段递归清洗
// maskApiKey 用于列表 / 配置展示；scrubSensitiveKeys 用于深拷贝时抹掉敏感字段

/**
 * 掩码 API 密钥：保留后 4 位，前缀加 3 个星号。
 * 短密钥（≤4 位）不泄露任何字符：整体用 * 填充到原长度。
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 4) {
    return '*'.repeat(apiKey.length)
  }
  return `***${apiKey.slice(-4)}`
}

// 敏感键名（大小写不敏感）：命中后整键值替换为 [REDACTED]
const SENSITIVE_KEY_RE = /^(authorization|api_key|apikey|x-api-key)$/i

/**
 * 递归深拷贝并清洗敏感字段：
 * - 键名匹配 authorization / api_key / apikey / x-api-key（忽略大小写）→ 值替换为 '[REDACTED]'
 * - 数组整体保留，逐项递归
 * - 其余对象键递归处理
 * - 标量原样返回
 */
export function scrubSensitiveKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    // 数组：逐项递归清洗后重建，保留结构
    return value.map((item) => scrubSensitiveKeys(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]'
      } else {
        out[key] = scrubSensitiveKeys(val)
      }
    }
    return out as T
  }
  return value
}

// 配置文件加载器：读取 JSONC（支持注释与尾逗号）并校验为 Config
import { readFileSync } from 'node:fs'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { ConfigSchema, type Config } from './schema.js'

/**
 * 类型化加载错误：
 * - PARSE：文件读取失败或 JSONC 语法错误
 * - VALIDATE：语法合法但不符合 ConfigSchema（message 带字段路径）
 */
export class ConfigError extends Error {
  readonly code: 'PARSE' | 'VALIDATE'
  readonly path?: string

  constructor(code: 'PARSE' | 'VALIDATE', message: string, path?: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.path = path
  }
}

/**
 * 从文件加载并校验配置。
 * 读取失败 / JSONC 语法错误 / 模式校验失败均抛出 ConfigError（含失败阶段 code 与文件路径）。
 */
export function loadConfigFromFile(path: string): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new ConfigError('PARSE', `读取配置文件失败: ${(err as Error).message}`, path)
  }

  // jsonc-parser 不主动抛错，错误收集到 errors 数组
  const errors: ParseError[] = []
  // allowTrailingComma：JSONC 允许尾逗号；注释由解析器自动剥离
  const raw: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const first = errors[0]
    throw new ConfigError(
      'PARSE',
      `JSONC 解析失败: ${printParseErrorCode(first.error)}（偏移 ${first.offset}）`,
      path,
    )
  }

  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    // 取第一个问题，路径形如 upstreams.0.baseUrl，根级显示 (root)
    const issue = result.error.issues[0]
    const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    throw new ConfigError('VALIDATE', `${fieldPath}: ${issue.message}`, path)
  }
  return result.data
}

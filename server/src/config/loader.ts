// 配置文件加载器：读取 JSONC（支持注释与尾逗号）并校验为 Config
import { readFileSync } from 'node:fs'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import {
  ConfigSchema,
  DownstreamModelEntrySchema,
  type Config,
  type DownstreamAliasGroup,
} from './schema.js'

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
 * 把下游模型映射归一化为 group 形态（{ disabled, candidates }）：
 * - 旧写法 `alias: [ ...candidates ]` → `alias: { disabled: false, candidates }`（缺省未关闭）
 * - 新写法 `alias: { disabled?, candidates }` → 直接走 zod 解析回填缺省字段
 * 该步骤先于 ConfigSchema 解析，确保下游模块只见 group 形态
 */
function normalizeDownstreamModels(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw
  }
  const source = raw as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const [alias, entry] of Object.entries(source)) {
    if (Array.isArray(entry)) {
      // 旧写法：直接当成候选数组；缺省 disabled=false 走 zod 解析时补齐
      normalized[alias] = { candidates: entry }
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>
      if (!('candidates' in obj) && !('disabled' in obj)) {
        // 复合空对象（极少见）：直接当成 group，让 schema 报更精准的 candidates 错误
        normalized[alias] = entry
      } else {
        normalized[alias] = entry
      }
    } else {
      normalized[alias] = entry
    }
  }
  return normalized
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

  // 先归一化 downstreamModels（接受旧裸数组形态），再用 ConfigSchema 校验整体
  const preChecked = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>), downstreamModels: normalizeDownstreamModels((raw as Record<string, unknown>).downstreamModels) }
    : raw

  const result = ConfigSchema.safeParse(preChecked)
  if (!result.success) {
    // 取第一个问题，路径形如 upstreams.0.baseUrl，根级显示 (root)
    const issue = result.error.issues[0]
    const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    throw new ConfigError('VALIDATE', `${fieldPath}: ${issue.message}`, path)
  }
  return result.data
}

/**
 * 把前端 PUT 上行的别名 entry 归一化成 group 形态，交给 schema 校验：
 * - 旧裸数组形态 → `{ disabled: false, candidates }`
 * - 缺失 disabled 字段的 group → 缺省 false
 * - 完整 group → 原样保留
 *
 * 候选级 disabled 已移除；如有遗留字段会被 schema 兜底为多余键拒绝（默认不通过 strict）。
 */
export function normalizeDownstreamAliasEntry(
  entry: unknown,
): DownstreamAliasGroup {
  if (Array.isArray(entry)) {
    return { disabled: false, candidates: entry as Config['downstreamModels'][string]['candidates'] }
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as { disabled?: unknown; candidates?: unknown }
    return {
      disabled: obj.disabled === true,
      candidates: Array.isArray(obj.candidates)
        ? (obj.candidates as Config['downstreamModels'][string]['candidates'])
        : [],
    }
  }
  return { disabled: false, candidates: [] }
}

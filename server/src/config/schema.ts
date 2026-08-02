// 配置的 Zod 模式定义：与计划中的 JSONC 配置结构一一对应
// 仅描述配置数据本身（upstreams + downstreamModels），加载/持久化/变更事件由 loader/store 负责
import { z } from 'zod'

/**
 * 单个上游提供商（OpenAI 兼容服务）：
 * - id：唯一标识，供候选列表与路由引用
 * - baseUrl：基础地址，必须是合法 URL
 * - apiKey：明文密钥（配置文件以 0600 权限落盘）
 * - timeoutMs：请求超时（毫秒），缺省 30000
 * - disabled：暂停开关，缺省 false
 */
export const UpstreamSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30000),
  disabled: z.boolean().default(false),
})

/**
 * 一个下游模型别名指向的单个候选上游：
 * - upstreamId：上游 id（须与 upstreams 中的条目对应）
 * - model：在上游侧使用的模型名
 */
export const UpstreamCandidateSchema = z.object({
  upstreamId: z.string(),
  model: z.string(),
})

/**
 * 下游模型别名 → 有序候选列表（至少 1 个，按顺序尝试、失败切换下一个）
 */
export const DownstreamModelSchema = z.array(UpstreamCandidateSchema).min(1)

/**
 * 完整配置：
 * - upstreams：上游列表（至少 1 个）
 * - downstreamModels：别名 → 候选列表的映射
 */
export const ConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
  downstreamModels: z.record(z.string(), DownstreamModelSchema),
})

// 导出的推断类型：全项目统一使用该类型表示一份配置
export type Config = z.infer<typeof ConfigSchema>

export type Upstream = z.infer<typeof UpstreamSchema>
export type UpstreamCandidate = z.infer<typeof UpstreamCandidateSchema>

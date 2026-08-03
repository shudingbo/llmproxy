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
 * 下行流监听配置（控制整个 server 进程对外暴露的 IP / 端口）：
 * - host：监听地址（IPv4 / IPv6 / Unix socket 名）；缺省 127.0.0.1
 * - port：TCP 端口（1-65535）；缺省 3000
 * 提示：socket 在进程启动时绑定，修改本节后必须重启进程才能生效；
 *       进程级配置变更不会通过文件监听即时应用，以避免出现端口漂移/重复绑定
 */
export const ServerListenSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3000),
})

/**
 * 路由配置（可选）：
 * - sessionAffinity：会话亲和路由的开关与自动清理参数
 *   - enabled：总开关，缺省 true
 *   - cleanupMaxAgeMs：会话保留期（毫秒），缺省 1 周；0 表示会话永不过期
 *   - cleanupIntervalMs：清理周期（毫秒），缺省 1 小时；0 表示关闭自动清理调度
 * 允许只写部分键，其余取默认；整个 routing 可缺省
 * 注：zod v4 中 `.default()` 不会把默认值再过一遍 schema（内部字段默认值不生效），
 *     故用 `.prefault({})` 让缺省的空对象先进入 schema 解析，从而级联内部默认值
 */
export const RoutingSchema = z.object({
  sessionAffinity: z
    .object({
      enabled: z.boolean().default(true),
      cleanupMaxAgeMs: z.number().int().min(0).default(604800000),
      cleanupIntervalMs: z.number().int().min(0).default(3600000),
    })
    .prefault({}),
})

/**
 * 完整配置：
 * - upstreams：上游列表（至少 1 个）
 * - downstreamModels：别名 → 候选列表的映射
 * - server：可选的下行流监听配置（host / port）；未指定时按缺省值
 * - routing：可选的路由配置（会话亲和等）；未指定时按缺省值
 */
export const ConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
  downstreamModels: z.record(z.string(), DownstreamModelSchema),
  server: ServerListenSchema.optional(),
  routing: RoutingSchema.optional(),
})

// 导出的推断类型：全项目统一使用该类型表示一份配置
export type Config = z.infer<typeof ConfigSchema>

export type Upstream = z.infer<typeof UpstreamSchema>
export type UpstreamCandidate = z.infer<typeof UpstreamCandidateSchema>
export type ServerListen = z.infer<typeof ServerListenSchema>
export type Routing = z.infer<typeof RoutingSchema>

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
 * - responsesApi：Responses API 处理方式，'native' 强制原生透传、
 *   'convert' 转换为 chat 再请求上游，缺省 'convert'（未配置 = 转换路径）；
 *   添加上游时可用管理端「检测」按钮自动判定该值
 *
 * 注意：max_context_length 是「模型 × 该上游实例」的属性，已移到 UpstreamCandidate；
 * 同一上游跑不同模型时，每个模型各自独立配置上下文大小。
 */
export const UpstreamSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30000),
  disabled: z.boolean().default(false),
  responsesApi: z.enum(['native', 'convert']).default('convert'),
})

/**
 * 一个下游模型别名指向的单个候选上游：
 * - upstreamId：上游 id（须与 upstreams 中的条目对应）
 * - model：在上游侧使用的模型名
 * - max_context_length：该上游上跑该模型时的最大上下文；
 *   可经管理端自动探测或手动设置；显式 null 表示清空，缺省即未设置
 *   （同一上游跑不同模型时各自独立，配置粒度对齐到候选而非上游）
 */
export const UpstreamCandidateSchema = z.object({
  upstreamId: z.string(),
  model: z.string(),
  max_context_length: z.number().int().positive().nullable().optional(),
})

/**
 * 下游模型别名 → 有序候选列表（至少 1 个，按顺序尝试、失败切换下一个）
 */
export const DownstreamModelSchema = z.array(UpstreamCandidateSchema).min(1)

/**
 * 进程级 server 配置（控制整个 server 进程的监听与请求体解析）：
 * - host：监听地址（IPv4 / IPv6 / Unix socket 名）；缺省 127.0.0.1
 * - port：TCP 端口（1-65535）；缺省 3000
 * - bodyLimit：JSON 请求体上限（'10mb' 等字符串或数字字节数）；缺省 '10mb'
 * 提示：socket 在进程启动时绑定、bodyLimit 在 createApp 装配时读取，
 *       修改本节后必须重启进程才能生效；
 *       进程级配置变更不会通过文件监听即时应用，以避免端口漂移/重复绑定
 */
export const ServerConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3000),
  bodyLimit: z.union([z.string().min(1), z.number().int().positive()]).default('10mb'),
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
 * - server：可选的进程级 server 配置（host / port / bodyLimit）；未指定时按缺省值
 * - routing：可选的路由配置（会话亲和等）；未指定时按缺省值
 */
export const ConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
  downstreamModels: z.record(z.string(), DownstreamModelSchema),
  server: ServerConfigSchema.optional(),
  routing: RoutingSchema.optional(),
})

// 导出的推断类型：全项目统一使用该类型表示一份配置
export type Config = z.infer<typeof ConfigSchema>
export type Upstream = z.infer<typeof UpstreamSchema>
export type UpstreamCandidate = z.infer<typeof UpstreamCandidateSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
export type Routing = z.infer<typeof RoutingSchema>

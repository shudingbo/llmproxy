// 配置存储：持有当前配置的内存态，负责校验、原子持久化与变更通知
// 不含文件监听（T6 的 watcher 负责）与任何日志输出（T7 负责）
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import fastDeepEqual from 'fast-deep-equal'
import { ConfigError, loadConfigFromFile } from './loader.js'
import { ConfigSchema, type Config } from './schema.js'

// 配置变更来源：管理端写入 / 文件监听发现 / 启动引导
export type WatchSource = 'admin' | 'watch' | 'bootstrap'

// 首次运行（配置文件不存在）时写入的 bootstrap 示例（JSONC：注释即文档）
const BOOTSTRAP_JSONC = `{
  // llmproxy 配置文件（JSONC：支持注释与尾逗号）
  // 修改后由文件监听自动重载；管理端页面修改会原子写回本文件

  // 下行流监听（控制 server 进程的 IP / 端口，未配置时使用 127.0.0.1:3000 缺省）
  // 环境变量 HOST / PORT 会覆盖此节；socket 在启动时绑定，需重启进程才能生效
  // "server": {
  //   "host": "127.0.0.1",
  //   "port": 3000,
  //   "bodyLimit": "10mb"  // JSON body 上限（'10mb' 等字符串或数字字节数；全局生效，改后重启）
  // },

  // 上游提供商列表：所有 OpenAI 兼容服务（OpenAI 官方、各类网关/自建服务）
  "upstreams": [
    {
      // 唯一标识：候选列表与路由通过它引用该上游
      "id": "openai-main",
      // 上游基础地址（须为合法 URL）
      "baseUrl": "https://api.openai.com/v1",
      // 上游 API 密钥（明文存储，文件权限 0600，请及时替换）
      "apiKey": "sk-REPLACE_ME",
      // 上游请求超时（毫秒），缺省 30000
      "timeoutMs": 60000,
      // 暂停开关：true 时该上游不参与路由
      "disabled": false,
      // Responses API 处理方式：'native' 强制原生透传；'convert' 转换为 chat 再请求上游；缺省 'convert'
      // 添加上游后可在管理端对上游点「检测」按钮，自动判定 native / convert 并填入
      // 例如： "responsesApi": "native"
    }
  ],

  // 下游模型别名 → 别名组（总开关 + 有序候选上游列表，按顺序尝试，失败自动切换下一个）
  // 也可直接写裸数组形态（自动归一化为 group），向下兼容
  "downstreamModels": {
    // 示例：别名 gpt-4 请求 openai-main 上游的 gpt-4 模型
    "gpt-4": {
      // 别名级总开关 disabled：true 时整个别名对外不可见（不论候选是否开启）；
      // false / 未配置 → 走候选级过滤（候选里只要还有 1 条未关闭就可用）
      "disabled": false,
      // 候选级可选字段：max_context_length = 该上游跑该模型时的最大上下文；
      // 可经管理端「自动」按钮探测 llama.cpp/LM Studio，缺省不设；null 表示显式清空
      // candidate.disabled：候选级开关（独立于上游级与别名级），true 时仅跳过该候选
      "candidates": [
        { "upstreamId": "openai-main", "model": "gpt-4" }
      ]
    },
    // 示例：本地模型别名，可再添加更多候选上游实现回退
    "llama3": {
      "disabled": false,
      "candidates": [
        { "upstreamId": "openai-main", "model": "gpt-4o-mini" }
      ]
    }
  }

  // API Key 鉴权（可选）：
  // enabled = true 后所有 /v1/* 与 /api/* 请求必须携带 Authorization: Bearer <Key>，
  // 否则返回 401。Key 通过管理端「API Keys」页面管理（增删改查），存 SQLite。
  // 关闭（缺省）时完全旁路鉴权中间件，向后兼容现有部署。
  // cleanupRetentionDays：过期 Key 在 DB 中保留多少天后才被自动清理（缺省 7，0 = 过期即清理）
  // "auth": {
  //   "enabled": false,
  //   "keyBytes": 24,
  //   "cleanupRetentionDays": 7
  // }
}
`

/**
 * 配置存储：构造时装载文件（缺失则写入 bootstrap 示例），
 * 提供 get / subscribe / set，并维护最近一次重载错误（供 T6 watcher 使用）。
 */
export class ConfigStore {
  // 当前生效配置（唯一的内存态）
  private current: Config
  private readonly path: string
  // 订阅者集合（变更时全量通知）
  private readonly subscribers = new Set<(config: Config, source: WatchSource) => void>()
  // 最近一次外部重载错误（T6 watcher 调用 setRecentReloadError 上报）
  private reloadError: unknown = null

  constructor(path: string) {
    this.path = path
    if (!existsSync(path)) {
      // 文件缺失：先写入 bootstrap 示例（临时文件 + 原子重命名），再装载为当前配置
      this.persist(BOOTSTRAP_JSONC)
      this.current = loadConfigFromFile(path)
      // 语义上完成一次“set bootstrap”：此刻 current 与文件已一致，
      // 走 set 会在去重步骤直接返回（既不重复写盘，构造期也无订阅者可通知）
      this.set(this.current, { source: 'bootstrap' })
    } else {
      this.current = loadConfigFromFile(path)
    }
  }

  /** 返回当前生效配置（内存快照的引用，只读使用） */
  get(): Config {
    return this.current
  }

  /**
   * 订阅配置变更；返回取消订阅函数。
   * 回调同步触发（fire-and-forget），参数为最新配置与变更来源。
   */
  subscribe(fn: (config: Config, source: WatchSource) => void): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  /**
   * 更新配置：
   * 1. 与当前内存配置深度相等 → 直接返回（不写盘、不通知订阅者）。
   *    这是“写盘 → 文件监听 → 再次 set”自触发死循环的兜底闸门。
   * 2. 重新走 ConfigSchema 校验（缺省字段会被补齐）。
   * 3. 写入 ${path}.tmp 后原子重命名到目标文件（对监听器可见的单一快照）。
   * 4. 更新内存态并通知全部订阅者。
   */
  set(newConfig: Config, opts: { source: WatchSource }): void {
    // 自触发去重（关键）：内容一致视为无变更，早退避免 watcher 自环
    if (fastDeepEqual(newConfig, this.current)) {
      return
    }

    const result = ConfigSchema.safeParse(newConfig)
    if (!result.success) {
      const issue = result.error.issues[0]
      const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      throw new ConfigError('VALIDATE', `${fieldPath}: ${issue.message}`)
    }
    const validated = result.data

    this.persist(JSON.stringify(validated, null, 2))
    this.current = validated
    for (const fn of [...this.subscribers]) {
      fn(validated, opts.source)
    }
  }

  /** 最近一次外部重载错误（无则 null）；由 T6 watcher 在重载失败时写入 */
  getRecentReloadError(): unknown {
    return this.reloadError
  }

  setRecentReloadError(err: unknown): void {
    this.reloadError = err
  }

  // 原子持久化：先写同目录临时文件（0o600），再重命名覆盖目标
  private persist(text: string): void {
    const tmpPath = `${this.path}.tmp`
    // mode 仅在文件新建时生效；rename 保留临时文件的权限
    writeFileSync(tmpPath, text, { mode: 0o600 })
    renameSync(tmpPath, this.path)
  }
}

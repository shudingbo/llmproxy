// 下行流监听参数解析：从配置 + 环境变量按固定优先级得出最终生效的 host / port
// 优先级：环境变量 HOST/PORT > 配置文件 server 节 > 缺省值（127.0.0.1:3000）
// socket 在进程启动时绑定；本函数仅在 startServer() 启动期调用一次，热重载不应用本节变更
import type { Config } from '../config/schema.js'

export interface ResolvedListen {
  host: string
  port: number
  // 哪个来源最终生效（仅日志用，绝不参与运行时分支）
  source: 'env' | 'config' | 'default'
}

export interface ResolveOptions {
  // 注入用于测试；缺省读 process.env
  env?: NodeJS.ProcessEnv
}

export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_PORT = 3000

/**
 * 解析下行流监听参数：返回 { host, port, source }
 * - env 优先（HOST / PORT）；未设则取 config.server；未配置则取缺省
 * - 配置节内 host / port 均为可选，缺省时同样落到全局缺省
 * - 端口来自环境变量时按字符串解析为整数，无效字符串回退到缺省并走完整分支
 */
export function resolveListen(config: Config, opts: ResolveOptions = {}): ResolvedListen {
  const env = opts.env ?? process.env

  const envPortRaw = env.PORT
  if (envPortRaw !== undefined && envPortRaw !== '') {
    const n = Number(envPortRaw)
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      return {
        host: env.HOST ?? config.server?.host ?? DEFAULT_HOST,
        port: n,
        source: 'env',
      }
    }
    // 无效 PORT 字符串：继续到下一来源（不抛错），避免运维手误直接拒启动
  }
  if (env.HOST !== undefined && env.HOST !== '') {
    return {
      host: env.HOST,
      port: config.server?.port ?? DEFAULT_PORT,
      source: 'env',
    }
  }

  const cfgServer = config.server
  if (cfgServer !== undefined) {
    if (cfgServer.host !== DEFAULT_HOST || cfgServer.port !== DEFAULT_PORT) {
      return { host: cfgServer.host, port: cfgServer.port, source: 'config' }
    }
    // 配置项与缺省完全一致时视为未配置，仍然报 default 以反映真实行为
  }

  return { host: DEFAULT_HOST, port: DEFAULT_PORT, source: 'default' }
}

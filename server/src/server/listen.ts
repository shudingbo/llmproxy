// 下行流监听参数解析：从命令行 / 配置按固定优先级得出最终生效的 host / port
// 优先级：命令行 --host/--port > 配置文件 server 节 > 缺省值（0.0.0.0:3000）
// socket 在进程启动时绑定；本函数仅在 startServer() 启动期调用一次，热重载不应用本节变更
import type { Config } from '../config/schema.js'

export interface ResolvedListen {
  host: string
  port: number
  // 哪个来源最终生效（仅日志用，绝不参与运行时分支）
  source: 'cli' | 'config' | 'default'
}

export type CliArgs = { host?: string; port?: number }

export interface ResolveOptions {
  // 命令行参数（最高优先级）：host/port 相互独立可选，任一项存在即 source='cli'
  cli?: CliArgs
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3000

/**
 * 解析下行流监听参数：返回 { host, port, source }
 * - cli 优先（--host / --port），未指定的一侧独立回落下一优先级
 * - 配置节内 host / port 均为可选，缺省时同样落到全局缺省
 */
export function resolveListen(config: Config, opts: ResolveOptions = {}): ResolvedListen {
  const cli = opts.cli

  // cli 分支：命令行参数最高优先级，host/port 相互独立可选。
  // 任一项存在即 source='cli'；未指定的一侧按 config → default 回落
  if (cli !== undefined && (cli.host !== undefined || cli.port !== undefined)) {
    // host 空字符串视为未设，走回落
    const cliHost = cli.host !== undefined && cli.host !== '' ? cli.host : undefined
    const cliPort = cli.port

    return {
      host: cliHost ?? config.server?.host ?? DEFAULT_HOST,
      port: cliPort ?? config.server?.port ?? DEFAULT_PORT,
      source: 'cli',
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

// 下行流监听参数解析单元测试：cli > config > 缺省 优先级 + 边界
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { DEFAULT_HOST, DEFAULT_PORT, resolveListen } from '../../src/server/listen.js'

const baseConfig: Config = {
  upstreams: [
    { id: 'a', baseUrl: 'https://x.example', apiKey: 'k', timeoutMs: 5000, disabled: false },
  ],
  downstreamModels: { m1: [{ upstreamId: 'a', model: 'm1' }] },
}

describe('resolveListen', () => {
  it('cli 提供 host+port 时全用 cli（source=cli）', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { cli: { host: '127.0.0.1', port: 3999 } },
    )
    expect(result).toEqual({ host: '127.0.0.1', port: 3999, source: 'cli' })
  })

  it('仅 cli port：port 用 cli，host 回落 config', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { cli: { port: 5000 } },
    )
    expect(result).toEqual({ host: '0.0.0.0', port: 5000, source: 'cli' })
  })

  it('仅 cli host：host 用 cli，port 回落 config', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { cli: { host: '127.0.0.1' } },
    )
    expect(result).toEqual({ host: '127.0.0.1', port: 8080, source: 'cli' })
  })

  it('cli host 空字符串视为未设（host 回落 config）', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { cli: { host: '', port: 3999 } },
    )
    expect(result).toEqual({ host: '0.0.0.0', port: 3999, source: 'cli' })
  })

  it('cli 与 config 同时存在：cli 优先', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { cli: { host: '127.0.0.1', port: 3999 } },
    )
    expect(result).toEqual({ host: '127.0.0.1', port: 3999, source: 'cli' })
  })

  it('仅配置文件提供 host/port 且与缺省不同时记 source=config', () => {
    const result = resolveListen({ ...baseConfig, server: { host: '0.0.0.0', port: 8080 } })
    expect(result).toEqual({ host: '0.0.0.0', port: 8080, source: 'config' })
  })

  it('无 cli + 无 config（或 config 与缺省一致）时落到缺省', () => {
    const noConfig = resolveListen(baseConfig)
    expect(noConfig).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, source: 'default' })
    const defaultConfig = resolveListen({ ...baseConfig, server: { host: DEFAULT_HOST, port: DEFAULT_PORT } })
    expect(defaultConfig.source).toBe('default')
  })
})

// 下行流监听参数解析单元测试：env > config > 缺省 优先级 + 边界
import { describe, expect, it } from 'vitest'
import type { Config } from '../config/schema.js'
import { DEFAULT_HOST, DEFAULT_PORT, resolveListen } from './listen.js'

const baseConfig: Config = {
  upstreams: [
    { id: 'a', baseUrl: 'https://x.example', apiKey: 'k', timeoutMs: 5000, disabled: false },
  ],
  downstreamModels: { m1: [{ upstreamId: 'a', model: 'm1' }] },
}

describe('resolveListen', () => {
  it('env / config / 缺省 三者全无时落到缺省', () => {
    const result = resolveListen(baseConfig, { env: {} })
    expect(result).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, source: 'default' })
  })

  it('仅配置文件提供 host/port 且与缺省不同时记 source=config', () => {
    const result = resolveListen({ ...baseConfig, server: { host: '0.0.0.0', port: 8080 } }, { env: {} })
    expect(result).toEqual({ host: '0.0.0.0', port: 8080, source: 'config' })
  })

  it('配置文件节与缺省完全一致时记 source=default', () => {
    const result = resolveListen({ ...baseConfig, server: { host: DEFAULT_HOST, port: DEFAULT_PORT } }, { env: {} })
    expect(result.source).toBe('default')
  })

  it('env HOST 覆盖 config host / 缺省 host', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { env: { HOST: '127.0.0.1' } },
    )
    expect(result.host).toBe('127.0.0.1')
    expect(result.port).toBe(8080)
    expect(result.source).toBe('env')
  })

  it('env PORT 覆盖 config port / 缺省 port', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { env: { PORT: '9000' } },
    )
    expect(result.host).toBe('0.0.0.0')
    expect(result.port).toBe(9000)
    expect(result.source).toBe('env')
  })

  it('env PORT 非数值字符串时回落到下一来源（不抛错）', () => {
    const result = resolveListen(
      { ...baseConfig, server: { host: '0.0.0.0', port: 8080 } },
      { env: { PORT: 'not-a-number' } },
    )
    // PORT 无效 → 不阻塞；走 config 节，8080 生效
    expect(result.port).toBe(8080)
    expect(result.source).toBe('config')
  })

  it('env PORT 越界（0 / 65536）同样回落（避免手误直接拒启动）', () => {
    const low = resolveListen(baseConfig, { env: { PORT: '0' } })
    expect(low.source).toBe('default')
    const high = resolveListen(baseConfig, { env: { PORT: '65536' } })
    expect(high.source).toBe('default')
  })

  it('env HOST 缺省时空字符串视为未设', () => {
    const result = resolveListen({ ...baseConfig, server: { host: '0.0.0.0', port: 8080 } }, { env: { HOST: '' } })
    expect(result.host).toBe('0.0.0.0')
    expect(result.source).toBe('config')
  })

  it('未注入 env 时读 process.env（默认行为不报错即可）', () => {
    // 仅保证不抛错；具体值依赖运行环境，不做内容断言
    expect(() => resolveListen(baseConfig)).not.toThrow()
  })
})

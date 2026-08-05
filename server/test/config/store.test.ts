// 存储测试：bootstrap 初始化、round-trip、自触发去重、原子写、订阅与错误上报
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfigFromFile } from '../../src/config/loader.js'
import { ConfigSchema, type Config } from '../../src/config/schema.js'
import { ConfigError } from '../../src/config/loader.js'
import { ConfigStore } from '../../src/config/store.js'

// 一份完整的配置样本
const sampleConfig: Config = {
  upstreams: [
    {
      id: 'openai-main',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      timeoutMs: 60000,
      disabled: false,
      responsesApi: 'convert',
    },
  ],
  downstreamModels: {
    'gpt-4': [{ upstreamId: 'openai-main', model: 'gpt-4' }],
  },
}

describe('ConfigStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmproxy-store-'))
    path = join(dir, 'config.jsonc')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件缺失时写入 bootstrap 示例并装载为当前配置', () => {
    const store = new ConfigStore(path)
    // 文件被创建且保留注释（证明写入的是 bootstrap 示例而非序列化 JSON）
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('//')
    // 当前配置可被加载且缺省字段生效
    const config = store.get()
    expect(config.upstreams.length).toBeGreaterThanOrEqual(1)
    expect(config.upstreams[0].timeoutMs).toBe(60000)
    expect(config.upstreams[0].disabled).toBe(false)
    expect(config.downstreamModels).toHaveProperty('gpt-4')
    // 无残留临时文件
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('bootstrap 示例内含 server 配置节注释（提示用户下行流监听可配置）', () => {
    const store = new ConfigStore(path)
    const content = readFileSync(path, 'utf-8')
    // 注释区告诉运维下行流的 IP/端口可配，给出现成的"取消注释即可"模板
    expect(content).toContain('"server"')
    expect(content).toContain('"host"')
    expect(content).toContain('"port"')
    // bootstrap 本身不带 server 字段，缺省无侵入
    expect(store.get().server).toBeUndefined()
  })

  it('文件已存在时直接装载', () => {
    writeFileSync(path, JSON.stringify(sampleConfig), 'utf-8')
    const store = new ConfigStore(path)
    expect(store.get()).toEqual(sampleConfig)
  })

  it('round-trip：set 后 get 一致，且文件内容为序列化配置', () => {
    const store = new ConfigStore(path)
    const fn = vi.fn()
    store.subscribe(fn)

    store.set(sampleConfig, { source: 'admin' })

    expect(store.get()).toEqual(sampleConfig)
    // 缺省字段被补齐后落盘（与内存态一致）
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(store.get())
    // 原子写不留临时文件
    expect(existsSync(`${path}.tmp`)).toBe(false)
    // 文件可重新加载，结果一致
    expect(loadConfigFromFile(path)).toEqual(sampleConfig)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(store.get(), 'admin')
  })

  it('自触发去重：内容相同的 set 不写盘、不通知订阅者', () => {
    const store = new ConfigStore(path)
    store.set(sampleConfig, { source: 'admin' })
    const got = store.get()
    const fileContent = readFileSync(path, 'utf-8')

    const fn = vi.fn()
    store.subscribe(fn)
    // 深相等但引用不同（模拟 watcher 重读文件后回写）
    const clone = JSON.parse(JSON.stringify(sampleConfig)) as Config
    store.set(clone, { source: 'watch' })

    expect(fn).not.toHaveBeenCalled()
    // 早退：内存态引用不变，文件未重写
    expect(store.get()).toBe(got)
    expect(readFileSync(path, 'utf-8')).toBe(fileContent)
  })

  it('订阅者可退订，退订后不再收到通知', () => {
    const store = new ConfigStore(path)
    const fn = vi.fn()
    const unsubscribe = store.subscribe(fn)

    store.set(sampleConfig, { source: 'admin' })
    unsubscribe()
    store.set(
      { ...sampleConfig, upstreams: [{ ...sampleConfig.upstreams[0], id: 'another' }] },
      { source: 'admin' },
    )

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('多个订阅者都会收到通知', () => {
    const store = new ConfigStore(path)
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    store.subscribe(fn1)
    store.subscribe(fn2)

    store.set(sampleConfig, { source: 'watch' })

    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('非法配置被 set 拒绝：抛 VALIDATE 错误且内存态/文件不变', () => {
    const store = new ConfigStore(path)
    store.set(sampleConfig, { source: 'admin' })
    const fileContent = readFileSync(path, 'utf-8')

    const bad = { ...sampleConfig, upstreams: [{ ...sampleConfig.upstreams[0], baseUrl: 'bad' }] }
    let caught: unknown
    try {
      store.set(bad, { source: 'admin' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe('VALIDATE')
    expect((caught as ConfigError).message).toContain('upstreams.0.baseUrl')
    expect(store.get()).toEqual(sampleConfig)
    expect(readFileSync(path, 'utf-8')).toBe(fileContent)
  })

  it('RecentReloadError 读写（供 T6 watcher 使用）', () => {
    const store = new ConfigStore(path)
    expect(store.getRecentReloadError()).toBeNull()
    const err = new Error('reload failed')
    store.setRecentReloadError(err)
    expect(store.getRecentReloadError()).toBe(err)
  })

  it('bootstrap 配置本身通过 ConfigSchema 校验', () => {
    const store = new ConfigStore(path)
    const result = ConfigSchema.safeParse(store.get())
    expect(result.success).toBe(true)
  })
})

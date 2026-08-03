// watcher 测试：外部修改文件后自动重载；非法内容保留旧配置并上报重载错误
// 使用真实 chokidar（真实文件系统），等待防抖时间（200ms）+ 冗余量后断言
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../../src/config/schema.js'
import { ConfigError } from '../../src/config/loader.js'
import { ConfigStore } from '../../src/config/store.js'
import { startConfigWatcher } from '../../src/config/watcher.js'
import type { FSWatcher } from 'chokidar'

// 一份完整的配置样本（与 store 测试一致）
const sampleConfig: Config = {
  upstreams: [
    {
      id: 'openai-main',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      timeoutMs: 60000,
      disabled: false,
    },
  ],
  downstreamModels: {
    'gpt-4': [{ upstreamId: 'openai-main', model: 'gpt-4' }],
  },
}

// 防抖 200ms + 事件传播冗余量：写盘后等待该时长再断言
const DEBOUNCE_SLACK_MS = 400

// 等待 watcher 就绪：ready 事件后才开始监听，避免写盘早于监听建立
async function waitReady(watcher: FSWatcher): Promise<void> {
  await once(watcher, 'ready')
}

describe('startConfigWatcher', () => {
  let dir: string
  let path: string
  let store: ConfigStore
  let watcher: FSWatcher

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'llmproxy-watcher-'))
    path = join(dir, 'config.jsonc')
    store = new ConfigStore(path)
    watcher = startConfigWatcher(path, store)
    await waitReady(watcher)
  })

  afterEach(async () => {
    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('外部写入合法配置：防抖后自动重载，且清除历史重载错误', async () => {
    // 不同于 bootstrap 的内容，确保不命中深比较去重
    const updated: Config = {
      upstreams: [{ ...sampleConfig.upstreams[0], id: 'external-edit' }],
      downstreamModels: sampleConfig.downstreamModels,
    }
    store.setRecentReloadError(new Error('历史错误'))
    writeFileSync(path, JSON.stringify(updated, null, 2), 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SLACK_MS))

    expect(store.get()).toEqual(updated)
    expect(store.getRecentReloadError()).toBeNull()
  })

  it('外部写入非法 JSONC：保留旧配置并上报 PARSE 错误', async () => {
    const before = store.get()
    // 截断的数组字面量：JSONC 语法错误
    writeFileSync(path, '{ "upstreams": [', 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SLACK_MS))

    expect(store.get()).toBe(before)
    const err = store.getRecentReloadError()
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).code).toBe('PARSE')
  })

  it('外部写入 schema 非法配置：保留旧配置并上报 VALIDATE 错误', async () => {
    const before = store.get()
    // JSONC 语法合法但 baseUrl 非法（不满足 URL 校验）
    const bad = { ...sampleConfig, upstreams: [{ ...sampleConfig.upstreams[0], baseUrl: 'not-a-url' }] }
    writeFileSync(path, JSON.stringify(bad, null, 2), 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SLACK_MS))

    expect(store.get()).toBe(before)
    const err = store.getRecentReloadError()
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).code).toBe('VALIDATE')
  })

  it('自触发去重：store.set 写盘回环到 watcher 后不再二次通知订阅者', async () => {
    // 订阅计数：admin set 应恰好通知 1 次，回环事件被深比较早退吞掉
    let notified = 0
    store.subscribe(() => {
      notified++
    })

    store.set(
      { ...sampleConfig, upstreams: [{ ...sampleConfig.upstreams[0], id: 'roundtrip' }] },
      { source: 'admin' },
    )
    expect(notified).toBe(1)

    // 等 watcher 读到自身写盘的内容并尝试回写（深相等 → 早退）
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SLACK_MS))

    expect(notified).toBe(1)
  })
})

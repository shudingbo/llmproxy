// 配置文件监听：监视外部对配置文件的修改（编辑器 / 管理端写回），自动重载并校验
// 200ms 防抖（awaitWriteFinish）规避编辑器分次写入产生的半成品快照；
// 自触发去重由 store.set 的深比较早退负责（自身写盘回环事件被吞掉），本模块不做额外去重
import chokidar from 'chokidar'
import { getLogger } from '../logger/index.js'
import { ConfigError, loadConfigFromFile } from './loader.js'
import type { ConfigStore } from './store.js'

/**
 * 启动配置文件监听并返回 chokidar watcher（调用方负责在关闭时 close()）。
 *
 * 文件变更时重新加载并校验：
 * - 合法：store.set(parsed, { source: 'watch' })；与内存态深相等时 store 直接早退，
 *   因此自身写盘回环不会触发重复通知（source 仅写入审计/订阅通知，不落盘）
 * - 非法（PARSE / VALIDATE）：保留旧配置，通过 setRecentReloadError 上报供管理端查询，
 *   日志只记错误码与信息，不落盘文件内容与堆栈
 */
export function startConfigWatcher(path: string, store: ConfigStore): ReturnType<typeof chokidar.watch> {
  const watcher = chokidar.watch(path, {
    // 防抖：文件大小连续 200ms 稳定才认定写入完成，规避编辑器分次保存
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    // 初始文件由 ConfigStore 构造（或 bootstrap）装载，无需再触发一次
    ignoreInitial: true,
  })

  watcher.on('change', () => {
    try {
      const parsed = loadConfigFromFile(path)
      store.set(parsed, { source: 'watch' })
      // 重载成功：清除上次的重载错误，管理端不再显示过期故障
      store.setRecentReloadError(null)
    } catch (err) {
      if (err instanceof ConfigError) {
        // 只记录错误码 + message（含字段路径 / 解析偏移），不外泄文件内容与堆栈
        store.setRecentReloadError(err)
        getLogger().error({ code: err.code }, `配置重载失败: ${err.message}`)
      } else {
        // set 阶段意外错误（loadConfigFromFile 已校验，理论上不可达）：同样上报，日志保持脱敏
        store.setRecentReloadError(err)
        getLogger().error({ code: 'UNKNOWN' }, '配置重载失败（未知错误）')
      }
    }
  })

  return watcher
}

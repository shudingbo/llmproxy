// 配置模块统一出口：模式、加载器、存储、文件监听
export { UpstreamSchema, UpstreamCandidateSchema, DownstreamModelSchema, ConfigSchema } from './schema.js'
export type { Config, Upstream, UpstreamCandidate } from './schema.js'
export { ConfigError, loadConfigFromFile } from './loader.js'
export { ConfigStore } from './store.js'
export type { WatchSource } from './store.js'
export { startConfigWatcher } from './watcher.js'

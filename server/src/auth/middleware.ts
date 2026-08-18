// API Key 鉴权中间件：装配层挂到 /v1/* 与 /api/*，鉴权开关关闭时旁路
// 决策路径：
//   1. 开关关闭 → next()（向后兼容）
//   2. 解析 Authorization 头拿 Bearer token；缺失/格式错误 → 401
//   3. SHA-256 哈希后按 hash 查 ApiKeyStore；不存在 → 401
//   4. 记录存在但 disabled → 401（与「不存在」同形，避免账户枚举）
//   5. 记录过期（expires_at != 0 且 now > expires_at）→ 401
//   6. 通过 → 触摸 last_used_at、next()；触摸失败仅告警、不阻断业务
//
// 401 响应采用 OpenAI 风格包络：{ error: 'invalid_api_key', code: '...' }，
// 避免向客户端暴露「开关开/关」「Key 不存在」「Key 过期」等可观察差异
import type { NextFunction, Request, Response } from 'express'
import type { ConfigStore } from '../config/store.js'
import { getLogger } from '../logger/index.js'
import type { ApiKeyStore } from './db.js'
import { hashApiKey, parseBearerToken } from './key.js'

// 鉴权依赖：ConfigStore 读开关；ApiKeyStore 查 hash
export interface AuthMiddlewareDeps {
  store: ConfigStore
  apiKeyStore: ApiKeyStore
}

// 标准 401 响应：错误代号 + 文案 + 顶级 error 字段；code 细分原因但默认固定字符串
// 避免信息泄漏：所有失败都用相同的 error 文案，code 仅供服务器侧日志区分
function unauthorized(res: Response, reason: string): void {
  // WWW-Authenticate 提示客户端应如何重试（RFC 7235 标准）
  res.setHeader('WWW-Authenticate', 'Bearer realm="llmproxy"')
  res.status(401).json({
    error: {
      message: 'Incorrect API key provided.',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
    code: reason,
  })
}

/**
 * 构造鉴权中间件：开关关闭时直接旁路 next()，不做任何 IO
 * 开关读取每次请求走 store.get()，保证 config 热更新即时生效
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const { store, apiKeyStore } = deps
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // 全局开关关闭：完全旁路中间件，不读 header、不查 DB
    if (store.get().auth?.enabled !== true) {
      next()
      return
    }
    const token = parseBearerToken(req.headers.authorization)
    if (token === undefined) {
      unauthorized(res, 'missing_or_malformed_authorization')
      return
    }
    const hash = hashApiKey(token)
    const row = apiKeyStore.getByHash(hash)
    // 不存在 / 已停用 / 已过期：都用相同 401，避免客户端枚举 Key 状态
    if (row === undefined || row.disabled !== 0) {
      unauthorized(res, 'unknown_api_key')
      return
    }
    const now = Date.now()
    if (row.expires_at !== 0 && now > row.expires_at) {
      unauthorized(res, 'expired_api_key')
      return
    }
    // 通过：触摸 last_used_at（异步 fire-and-forget，失败仅告警，不影响本次响应）
    try {
      apiKeyStore.touch(row.id)
    } catch (err) {
      getLogger().warn({ err, keyId: row.id }, 'API Key 触摸 last_used_at 失败')
    }
    next()
  }
}
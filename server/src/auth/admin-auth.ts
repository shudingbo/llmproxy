// 管理员登录鉴权核心：密码摘要算法、Cookie 工具、管理端会话中间件
// 设计要点：
//   - 密码链路：前端计算 MD5(salt + ts + password) 上传；服务端用配置中的明文密码重算同式摘要，
//     以 timingSafeEqual 恒时比较（防时序攻击）。ts 为 epoch 秒，±60s 窗口防重放
//   - 会话：sessionId 为 32 字节 CSPRNG hex，存 SQLite（admin_sessions 表），24h 滑动过期；
//     Cookie 仅存 sessionId（HttpOnly + SameSite=Lax），不落明文密码
//   - 中间件白名单：/auth/salt、/auth/status、/auth/login、/auth/logout 放行；其余 /admin/api/* 须持有效会话
//
// 401 响应统一包络 { status: false, msg, error: 'unauthenticated' }：
//   「无 Cookie / 会话不存在 / 会话过期」对外同形，避免枚举
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { getLogger } from '../logger/index.js'
import type { AdminSessionRow, AdminSessionStore } from './session-store.js'

// 管理端会话 Cookie 名（仅承载 sessionId，HttpOnly 防脚本读取）
export const ADMIN_SESSION_COOKIE = 'llmproxy_admin_sid'

// 会话存活时长：24 小时（每次有效访问滑动续期）
export const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000

// ts 防重放窗口：±60 秒（前后各 1 分钟容忍时钟漂移）
export const ADMIN_TS_WINDOW_SECONDS = 60

// 扩展 Express Request：鉴权中间件通过后挂载当前登录管理员
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUser?: { username: string }
    }
  }
}

/**
 * 计算 MD5 摘要（hex 小写，32 字符）：
 * - 登录链路统一摘要函数；服务端与前端约定同一算法
 */
export function computeMd5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 登录摘要：MD5(salt + ts + password)。
 * - salt：配置中的静态盐（32 字节 hex）
 * - ts：epoch 秒（数字直接拼接为十进制字符串）
 * - 服务端用配置明文密码重算本式，与客户端上送摘要恒时比较
 */
export function computePasswordHash(salt: string, ts: number, password: string): string {
  return computeMd5Hex(`${salt}${ts}${password}`)
}

/**
 * 恒时比较两个 hex 摘要（防时序攻击）：
 * - 长度不一致直接 false（不进入比较，避免 timingSafeEqual 抛错）
 * - 相同长度走 crypto.timingSafeEqual
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * 校验 ts 防重放窗口：
 * - ts 必须为整数（epoch 秒）
 * - |floor(now/1000) - ts| <= ADMIN_TS_WINDOW_SECONDS 视为有效
 */
export function isTsWithinWindow(ts: number, now: number = Date.now()): boolean {
  if (!Number.isInteger(ts)) {
    return false
  }
  return Math.abs(Math.floor(now / 1000) - ts) <= ADMIN_TS_WINDOW_SECONDS
}

// 生成会话 ID：32 字节 CSPRNG hex（64 字符），不可猜测
export function generateSessionId(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 从请求 Cookie 头手工解析指定 Cookie 值（不引入 cookie-parser 依赖）：
 * - Cookie 头形如 "a=1; b=2"；同名取第一个出现值
 * - 无头 / 无该 Cookie / 空值 → undefined
 */
export function parseCookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') {
    return undefined
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) {
      continue
    }
    const key = part.slice(0, idx).trim()
    if (key !== name) {
      continue
    }
    const value = part.slice(idx + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

// 种会话 Cookie：HttpOnly + SameSite=Lax + Path=/；Max-Age 与 TTL 对齐
export function setSessionCookie(res: Response, sessionId: string): void {
  const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000)
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  )
}

// 清除会话 Cookie：Max-Age=0 让浏览器立即删除
export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// 鉴权依赖：会话存储（查 / 续期）
export interface AdminAuthMiddlewareDeps {
  adminSessionStore: AdminSessionStore
}

/**
 * 管理端会话鉴权中间件（仅按路由应用于管理员管理端点：change-password / admins CRUD）：
 * 1. 读 Cookie 取 sessionId；缺失 → 401
 * 2. 按 sessionId 查会话；不存在 → 401（与缺失同形，防枚举）
 * 3. 会话过期 → 清理该会话并 401
 * 4. 有效 → 滑动续期（touch 失败仅告警不阻断）→ 挂 req.adminUser → next()
 */
export function createAdminAuthMiddleware(deps: AdminAuthMiddlewareDeps) {
  const { adminSessionStore } = deps
  return function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const unauthorized = (reason: string): void => {
      // 所有失败对外同形；reason 仅供服务端日志区分
      getLogger().debug({ reason, path: req.path }, 'admin auth rejected')
      res.status(401).json({ status: false, msg: '未登录或会话已过期', error: 'unauthenticated' })
    }
    const sessionId = parseCookieValue(req, ADMIN_SESSION_COOKIE)
    if (sessionId === undefined) {
      unauthorized('missing_session_cookie')
      return
    }
    let row: AdminSessionRow | undefined
    try {
      row = adminSessionStore.getBySessionId(sessionId)
    } catch (err) {
      // 存储异常不放行：记录后按未认证处理
      getLogger().warn({ err }, 'admin session lookup failed')
      unauthorized('store_lookup_error')
      return
    }
    if (row === undefined) {
      unauthorized('unknown_session')
      return
    }
    const now = Date.now()
    if (now >= row.expires_at) {
      // 过期：尽力清理，随后拒绝
      try {
        adminSessionStore.delete(sessionId)
      } catch {
        // 清理失败不影响拒绝语义
      }
      unauthorized('expired_session')
      return
    }
    // 滑动续期：刷新 last_seen_at 与 expires_at；失败仅告警，不影响本次放行
    try {
      adminSessionStore.touch(sessionId, ADMIN_SESSION_TTL_MS, now)
    } catch (err) {
      getLogger().warn({ err, username: row.username }, 'admin session touch failed')
    }
    req.adminUser = { username: row.username }
    next()
  }
}

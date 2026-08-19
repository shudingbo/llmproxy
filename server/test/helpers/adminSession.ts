// 测试共享助手：直接向 AdminSessionStore 写入一个有效会话，返回自动携带会话 Cookie 的 supertest 请求工厂。
// 背景：管理端现已全局挂载 adminAuth（白名单除外），绝大多数用例不关心鉴权本身，需要一个「已登录」身份。
// createAdminAuthMiddleware 只按 Cookie 查 adminSessionStore（不读 admins 配置），
// 因此直接落一条会话 + 发 Cookie 即可通过鉴权——无需走 login 流程，也不会改变配置形状（避免破坏落盘内容断言）。
import request from 'supertest'
import type { SuperAgentTest, Test } from 'supertest'
import type { Express } from 'express'
import type { AdminSessionStore } from '../../src/auth/session-store.js'
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS, generateSessionId } from '../../src/auth/admin-auth.js'

type Verb = (url: string) => Test

// supertest 7 的 request(app) 运行时返回纯「动词方法对象」（对象本身没有 .set），
// Cookie 必须挂在动词方法返回的 Test 上，故此处对每个动词方法统一包装注入会话 Cookie
export function adminRequest(app: Express, adminSessionStore: AdminSessionStore, username = 'admin'): () => SuperAgentTest {
  const sessionId = generateSessionId()
  adminSessionStore.create({ sessionId, username, ttlMs: ADMIN_SESSION_TTL_MS })
  const cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`
  const base = request(app) as unknown as Record<string, Verb>
  const wrapped: Record<string, Verb> = {}
  for (const key of Object.keys(base)) {
    const verb = base[key]
    wrapped[key] = (url) => verb(url).set('Cookie', cookie)
  }
  return () => wrapped as unknown as SuperAgentTest
}

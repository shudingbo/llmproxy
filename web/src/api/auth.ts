import { md5 } from 'js-md5'
import { api } from './client'

// 登录盐 + 时间戳（单次 nonce 防重放：服务端校验 ts 在 ±60 秒内）
export interface SaltInfo {
  salt: string
  ts: number
}

// 登录态查询结果（GET /auth/status 为公开端点，无会话时 authenticated=false）
export interface AuthStatus {
  authenticated: boolean
  username?: string
}

// 计算登录用密码摘要：MD5(salt + ts + password)
// 浏览器 SubtleCrypto 不支持 MD5，故用 js-md5；salt + ts 组合压缩重放窗口
export function computePasswordMd5(salt: string, ts: number, password: string): string {
  return md5(salt + String(ts) + password)
}

// 获取登录盐与时间戳（公开端点）
export async function fetchSalt(): Promise<SaltInfo> {
  const { data } = await api.get<SaltInfo>('/auth/salt')
  return data
}

// 查询当前登录态（公开端点，带会话 cookie 才返回 authenticated=true）
export async function getAuthStatus(): Promise<AuthStatus> {
  const { data } = await api.get<AuthStatus>('/auth/status')
  return data
}

// 登录：拉取 salt/ts → 计算 MD5 → POST /auth/login
// 成功返回登录账号名；失败抛出后端错误（401 { status: false, msg }）
export async function login(username: string, password: string): Promise<string> {
  const { salt, ts } = await fetchSalt()
  const passwordMd5 = computePasswordMd5(salt, ts, password)
  const { data } = await api.post<{ status: boolean; username: string; msg?: string }>('/auth/login', {
    username,
    passwordMd5,
  })
  return data.username
}

// 退出登录：清除会话 cookie（后端幂等，失败不阻断前端清态）
export async function logout(): Promise<void> {
  await api.post('/auth/logout')
}

// 修改自己的密码：旧密码以 MD5 摘要上传，新密码明文（后端落配置）
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const { salt, ts } = await fetchSalt()
  const oldPasswordMd5 = computePasswordMd5(salt, ts, oldPassword)
  await api.post('/auth/change-password', { oldPasswordMd5, newPassword })
}

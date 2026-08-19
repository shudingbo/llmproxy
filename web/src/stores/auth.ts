import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAuthStatus, login as apiLogin, logout as apiLogout } from '../api/auth'

// 登录用户（仅保留管理端需要的最小字段）
export interface AuthUser {
  username: string
}

// 认证状态 store（Pinia setup 语法）
// user 为当前登录账号；checked 表示「已向后端确认过登录态」，供路由守卫判断是否就绪
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  const checked = ref(false)

  const isAuthenticated = computed(() => user.value !== null)

  // 共享同一 in-flight promise，避免 main.ts 预热与守卫兜底重复请求
  let initPromise: Promise<void> | null = null

  // 初始化：查询 /auth/status 恢复登录态（页面刷新后凭 HttpOnly cookie 免重登）
  // 查询失败视为未登录（不抛错，交给路由守卫决定跳转）
  function init(): Promise<void> {
    if (checked.value) {
      return Promise.resolve()
    }
    if (initPromise) {
      return initPromise
    }
    initPromise = (async () => {
      try {
        const status = await getAuthStatus()
        user.value = status.authenticated && status.username ? { username: status.username } : null
      } catch {
        user.value = null
      } finally {
        checked.value = true
      }
    })()
    return initPromise
  }

  // 登录成功：记录账号并标记已检查
  function setAuthenticated(username: string): void {
    user.value = { username }
    checked.value = true
  }

  // 仅清空前端登录态（不调后端）：供 axios 401 拦截在会话失效时同步前端状态，
  // 避免路由守卫因「仍认为已登录」而把 /login 弹回受保护页
  function clearAuth(): void {
    user.value = null
    checked.value = true
  }

  // 登出：调用后端清 cookie（失败不阻断），清空本地登录态
  async function logout(): Promise<void> {
    try {
      await apiLogout()
    } catch {
      // 后端清 cookie 失败不影响前端登出体验
    }
    user.value = null
    checked.value = true
  }

  return { user, checked, isAuthenticated, init, setAuthenticated, clearAuth, logout }
})

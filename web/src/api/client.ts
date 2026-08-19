import axios from 'axios'

// 管理端 API 客户端：统一 /admin/api 前缀（开发环境由 Vite 代理转发到后端）
// withCredentials：让浏览器携带 HttpOnly 会话 cookie（管理员登录态）
export const api = axios.create({
  baseURL: '/admin/api',
  withCredentials: true,
})

// 401 响应拦截：会话失效或受保护接口未登录时，清除前端登录态并跳转登录页（保留回跳地址）
// 注意：这里用动态 import 获取 router 与 store，避免 client → router → 布局 → store → client 的循环依赖
api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    if (status === 401) {
      const [{ default: router }, { useAuthStore }] = await Promise.all([
        import('../router'),
        import('../stores/auth'),
      ])
      // 先同步前端登录态：否则路由守卫仍认为已登录，会把 /login 弹回受保护页，导致无法重新登录
      useAuthStore().clearAuth()
      const current = router.currentRoute.value
      if (current.path !== '/login') {
        // 保留当前完整路径（含 query）作为登录成功后的回跳地址
        await router.push({ path: '/login', query: { redirect: current.fullPath } })
      }
    }
    return Promise.reject(error)
  },
)

export default api

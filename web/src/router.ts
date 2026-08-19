import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AdminLayout from './layouts/AdminLayout.vue'
import { useAuthStore } from './stores/auth'

// 路由表：登录页独立于管理布局；其余页面挂在 AdminLayout 下
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/Login.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: 'Dashboard', icon: 'DataAnalysis' } },
      { path: 'upstreams', component: () => import('./views/Upstreams.vue'), meta: { title: 'Upstreams', icon: 'Connection' } },
      { path: 'models', component: () => import('./views/Models.vue'), meta: { title: 'Models', icon: 'Files' } },
      { path: 'api-keys', component: () => import('./views/ApiKeys.vue'), meta: { title: 'API Keys', icon: 'Key' } },
      { path: 'admin-users', component: () => import('./views/AdminUsers.vue'), meta: { title: 'Admin Users', icon: 'User' } },
      { path: 'logs', component: () => import('./views/Logs.vue'), meta: { title: 'Logs', icon: 'Document' } },
      { path: 'sessions', component: () => import('./views/Sessions.vue'), meta: { title: 'Sessions', icon: 'Link' } },
      { path: 'stats', component: () => import('./views/Stats.vue'), meta: { title: 'Stats', icon: 'TrendCharts' } },
      { path: 'system-config', component: () => import('./views/SystemConfig.vue'), meta: { title: 'System Config', icon: 'Setting' } },
      { path: 'chat', component: () => import('./views/Chat.vue'), meta: { title: 'Chat', icon: 'ChatDotRound' } },
    ],
  },
]

// 创建路由实例（history 模式），由 main.ts 安装
const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 全局守卫：未登录访问受保护页面 → 跳 /login?redirect=<原路径>；已登录访问 /login → 跳 /dashboard
// 守卫为异步：登录态未确认时先 await auth.init()（防止刷新瞬间误判跳转）
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.checked) {
    await auth.init()
  }
  if (to.path !== '/login' && !auth.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.path === '/login' && auth.isAuthenticated) {
    return { path: '/dashboard' }
  }
  return true
})

export default router

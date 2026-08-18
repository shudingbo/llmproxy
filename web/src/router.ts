import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AdminLayout from './layouts/AdminLayout.vue'

// 路由表：根路径挂载管理端布局，子路由为各页面（暂为占位）
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: 'Dashboard', icon: 'DataAnalysis' } },
      { path: 'upstreams', component: () => import('./views/Upstreams.vue'), meta: { title: 'Upstreams', icon: 'Connection' } },
      { path: 'models', component: () => import('./views/Models.vue'), meta: { title: 'Models', icon: 'Files' } },
      { path: 'api-keys', component: () => import('./views/ApiKeys.vue'), meta: { title: 'API Keys', icon: 'Key' } },
      { path: 'logs', component: () => import('./views/Logs.vue'), meta: { title: 'Logs', icon: 'Document' } },
      { path: 'sessions', component: () => import('./views/Sessions.vue'), meta: { title: 'Sessions', icon: 'Link' } },
      { path: 'stats', component: () => import('./views/Stats.vue'), meta: { title: 'Stats', icon: 'TrendCharts' } },
      { path: 'system-config', component: () => import('./views/SystemConfig.vue'), meta: { title: 'System Config', icon: 'Setting' } },
    ],
  },
]

// 创建路由实例（history 模式），由 main.ts 安装
export default createRouter({
  history: createWebHistory(),
  routes,
})

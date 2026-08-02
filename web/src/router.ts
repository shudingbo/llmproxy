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
      { path: 'logs', component: () => import('./views/Logs.vue'), meta: { title: 'Logs', icon: 'Document' } },
      { path: 'stats', component: () => import('./views/Stats.vue'), meta: { title: 'Stats', icon: 'TrendCharts' } },
    ],
  },
]

// 创建路由实例（history 模式），由 main.ts 安装
export default createRouter({
  history: createWebHistory(),
  routes,
})

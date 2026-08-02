import axios from 'axios'

// 管理端 API 客户端：统一 /admin/api 前缀（开发环境由 Vite 代理转发到后端）
export const api = axios.create({
  baseURL: '/admin/api',
})

export default api

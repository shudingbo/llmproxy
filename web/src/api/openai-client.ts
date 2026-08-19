import axios from 'axios'

// OpenAI 兼容端点客户端：统一 /v1 前缀（开发环境由 Vite 代理转发到后端）
// 与 admin 客户端（client.ts）刻意不同：
// - withCredentials: false —— 聊天请求不携带管理端会话 cookie，与登录态解耦
// - 无 401 拦截器 —— /v1 的 401 必须原样抛给调用方展示，不能跳转登录页
// - 不持有 apiKey —— 密钥由调用方按请求传入，避免挂在实例上
export const openaiClient = axios.create({
  baseURL: '/v1',
  withCredentials: false,
})

export default openaiClient
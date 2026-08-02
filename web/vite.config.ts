import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// Vite 前端构建配置：Vue 插件 + Element Plus 按需自动导入
export default defineConfig({
  plugins: [
    vue(),
    // 自动导入 Vue / Vue Router 等 API，无需手动 import
    AutoImport({
      resolvers: [ElementPlusResolver()],
    }),
    // 自动注册 Element Plus 组件（按需加载样式）
    Components({
      resolvers: [ElementPlusResolver()],
    }),
  ],
  server: {
    port: 5173,
    // 开发代理：把 /admin/api 前缀的请求转发到后端服务
    proxy: {
      '/admin/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})

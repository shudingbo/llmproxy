import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'


/**************** 拦截 history 方法 ，处理 vue router 在 edge 浏览器 最小化时，会恢复*/
// 检测是否为 Edge 浏览器
const isEdge = /Edg\//.test(navigator.userAgent);
if (isEdge) {
  // 保存原生 replaceState 方法
  const originalReplaceState = history.replaceState;

  // 用新方法替换它
  history.replaceState = function (...args) {
    // 如果当前页面是隐藏状态，直接返回，不执行 replaceState
    if (document.visibilityState === "hidden") {
      return;
    }
    // 否则，调用原生的 replaceState 方法
    return originalReplaceState.apply(this, args);
  };
}

// 创建应用实例
const app = createApp(App)

// 全局注册 Element Plus 图标（按 key 名注册为组件）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

// 安装 Pinia（状态管理）、Vue Router、Element Plus
app.use(createPinia())

// 预热登录态：提前发起 /auth/status 查询，路由守卫随后 await auth.init() 即可拿到结果
// （不阻塞 mount；查询失败视为未登录，由守卫跳转 /login）
const auth = useAuthStore()
void auth.init()

app.use(router)
app.use(ElementPlus)

app.mount('#app')

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'

// 创建应用实例
const app = createApp(App)

// 全局注册 Element Plus 图标（按 key 名注册为组件）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

// 安装 Pinia（状态管理）、Vue Router、Element Plus
app.use(createPinia())
app.use(router)
app.use(ElementPlus)

app.mount('#app')

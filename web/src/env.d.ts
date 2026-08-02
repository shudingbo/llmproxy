/// <reference types="vite/client" />

// Vue 单文件组件模块类型声明，让 TS 识别 .vue 导入
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>
  export default component
}

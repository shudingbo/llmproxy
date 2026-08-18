<template>
  <!-- 管理端整体布局：左侧导航菜单 + 右侧主内容区（跨页面保持） -->
  <el-container class="admin-layout">
    <!-- 侧边栏 -->
    <el-aside width="220px" class="admin-aside">
      <!-- 应用标题 -->
      <div class="admin-brand">LLMProxy</div>
      <!-- 侧边导航菜单：router 模式点击即跳转 -->
      <el-menu :default-active="activeMenu" router class="admin-menu">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <!-- 主内容区：渲染当前路由页面 -->
    <el-main class="admin-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  DataAnalysis,
  Connection,
  Files,
  Key,
  Document,
  Link,
  TrendCharts,
} from '@element-plus/icons-vue'

// 菜单配置：路径与图标一一对应（与路由表保持一致）
const menuItems = [
  { path: '/dashboard', title: 'Dashboard', icon: DataAnalysis },
  { path: '/upstreams', title: 'Upstreams', icon: Connection },
  { path: '/models', title: 'Models', icon: Files },
  { path: '/api-keys', title: 'API Keys', icon: Key },
  { path: '/logs', title: 'Logs', icon: Document },
  { path: '/sessions', title: 'Sessions', icon: Link },
  { path: '/stats', title: 'Stats', icon: TrendCharts },
]

// 当前激活菜单项：跟随路由路径高亮
const route = useRoute()
const activeMenu = computed(() => route.path)
</script>

<style scoped>
.admin-layout {
  height: 100vh;
}

.admin-aside {
  border-right: 1px solid var(--el-border-color-light);
}

.admin-brand {
  height: 56px;
  line-height: 56px;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.admin-menu {
  border-right: none;
}
</style>

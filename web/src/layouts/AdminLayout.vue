<template>
  <!-- 管理端整体布局：左侧导航菜单 + 右侧（顶栏 + 主内容区，跨页面保持） -->
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

    <!-- 右侧：顶部用户栏 + 主内容区 -->
    <el-container class="admin-body" direction="vertical">
      <el-header class="admin-header" height="56px">
        <div class="header-right">
          <span class="welcome">欢迎，{{ auth.user?.username }}</span>
          <el-button type="primary" link @click="logout">退出</el-button>
        </div>
      </el-header>

      <!-- 主内容区：渲染当前路由页面 -->
      <el-main class="admin-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ChatDotRound,
  DataAnalysis,
  Connection,
  Files,
  Key,
  User,
  Document,
  Link,
  TrendCharts,
  Setting,
} from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

// 菜单配置：路径与图标一一对应（与路由表保持一致）
const menuItems = [
  { path: '/dashboard', title: 'Dashboard', icon: DataAnalysis },
  { path: '/upstreams', title: 'Upstreams', icon: Connection },
  { path: '/models', title: 'Models', icon: Files },
  { path: '/logs', title: 'Logs', icon: Document },
  { path: '/sessions', title: 'Sessions', icon: Link },
  { path: '/stats', title: 'Stats', icon: TrendCharts },
  { path: '/system-config', title: 'System Config', icon: Setting },
  { path: '/api-keys', title: 'API Keys', icon: Key },
  { path: '/admin-users', title: 'Admin Users', icon: User },
  { path: '/chat', title: 'Chat', icon: ChatDotRound },
]

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 当前激活菜单项：跟随路由路径高亮
const activeMenu = computed(() => route.path)

// 退出登录：清会话 + 本地态，跳登录页
async function logout(): Promise<void> {
  await auth.logout()
  router.push('/login')
}
</script>

<style scoped>
.admin-layout {
  height: 100vh;
}

.admin-body {
  min-width: 0;
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

/* 顶栏：右侧对齐（用户名 + 退出），左留白 */
.admin-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.welcome {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>

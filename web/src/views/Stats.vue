<template>
  <div class="stats-page">
    <!-- 页面头部：标题 + 统计窗口说明 + 手动刷新按钮 -->
    <div class="page-header">
      <div>
        <h2 class="page-title">Stats</h2>
        <!-- since 为空（未加载）时不展示说明文案 -->
        <p v-if="since" class="page-subtitle">
          Counters reset on restart. Showing data since {{ since }}
        </p>
      </div>
      <el-button :loading="loading" @click="refresh">
        Refresh
      </el-button>
    </div>

    <!-- 3 个 KPI 卡片：总请求数 / 总错误数 / 平均延迟（进程启动以来累计） -->
    <el-row :gutter="16" class="kpi-row">
      <el-col :span="8">
        <el-card shadow="never">
          <el-statistic title="Total Requests" :value="stats?.totals.requests ?? 0" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <el-statistic title="Total Errors" :value="stats?.totals.errors ?? 0" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <el-statistic title="Avg Latency (ms)" :value="stats?.totals.avgLatencyMs ?? 0" :precision="2" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 分上游明细表：ID / 请求数 / 错误数 / 平均延迟 -->
    <el-card shadow="never" class="table-card">
      <el-table :data="stats?.perUpstream ?? []" v-loading="loading" stripe>
        <el-table-column prop="upstreamId" label="Upstream ID" min-width="160" />
        <el-table-column prop="requests" label="Requests" min-width="100" />
        <el-table-column prop="errors" label="Errors" min-width="100" />
        <!-- 平均延迟保留 2 位小数，单位为毫秒 -->
        <el-table-column label="Avg Latency (ms)" min-width="140">
          <template #default="{ row }">
            {{ row.avgLatencyMs.toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api/client'

// 单条上游统计（与后端 /admin/api/stats 响应字段一致）
interface PerUpstreamStats {
  upstreamId: string
  requests: number
  errors: number
  avgLatencyMs: number
  totalLatencyMs: number
}

// 统计接口整体响应：since 为统计窗口起点 ISO 串
interface StatsResponse {
  since: string
  totals: { requests: number; errors: number; avgLatencyMs: number }
  perUpstream: PerUpstreamStats[]
}

// 页面状态：加载中标记、统计窗口起点、统计数据本体
const loading = ref(false)
const since = ref('')
const stats = ref<StatsResponse | null>(null)

// 30s 自动刷新定时器句柄（卸载时清理）
const REFRESH_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | undefined

// 拉取最新统计快照；失败仅打印日志，保留旧数据不打断页面
async function refresh(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get<StatsResponse>('/stats')
    stats.value = data
    since.value = data.since
  } catch (err) {
    console.error('获取统计信息失败', err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, REFRESH_INTERVAL_MS)
})

onUnmounted(() => {
  clearInterval(timer)
})
</script>

<style scoped>
.stats-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 头部：标题与说明左对齐，刷新按钮靠右 */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 20px;
}

.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.table-card {
  flex: 1;
}
</style>

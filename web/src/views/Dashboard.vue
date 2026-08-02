<script setup lang="ts">
// 仪表盘页：4 张指标卡片（活跃上游 / 模型总数 / 请求数 / 错误率）
// 数据来源：upstreams（活跃数）、downstream-models（别名数）、stats（进程启动以来的请求与错误）
// 30s 自动刷新 + 手动刷新按钮；统计口径为内存态（进程启动起算），副标题注明 since 起点
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../api/client'

// 上游条目（与后端 UpstreamSchema 对应；apiKey 已掩码，仅用于统计活跃数）
interface Upstream {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  disabled?: boolean
}

// 统计接口响应：since 为进程启动时间（ISO 字符串），totals 为全量汇总
interface StatsResponse {
  since: string
  totals: {
    requests: number
    errors: number
    avgLatencyMs: number
  }
}

// 计数器与统计元数据
const activeUpstreams = ref(0)
const totalModels = ref(0)
const requests = ref(0)
const errorRate = ref(0)
const errorRateValid = ref(false)
const since = ref('')
const lastUpdated = ref('')
const loading = ref(false)

// 错误率文本：无请求时显示占位符 "—"
const errorRateText = computed(() => {
  if (!errorRateValid.value) {
    return '—'
  }
  return `${errorRate.value.toFixed(2)}%`
})

// 异步加载全部卡片数据：三个接口并发请求，任一失败即整体报错（ElMessage 提示）
async function load(): Promise<void> {
  loading.value = true
  try {
    const [upstreamsRes, modelsRes, statsRes] = await Promise.all([
      api.get<Upstream[]>('/upstreams'),
      api.get<Record<string, unknown>>('/downstream-models'),
      api.get<StatsResponse>('/stats'),
    ])
    // 活跃上游：排除 disabled 的上游
    activeUpstreams.value = upstreamsRes.data.filter((u) => u.disabled !== true).length
    // 模型总数：下游模型映射的别名个数
    totalModels.value = Object.keys(modelsRes.data).length
    const totals = statsRes.data.totals
    requests.value = totals.requests
    // 错误率 = errors / requests * 100；无请求时视为无有效错误率
    errorRateValid.value = totals.requests > 0
    errorRate.value = totals.requests > 0 ? (totals.errors / totals.requests) * 100 : 0
    since.value = statsRes.data.since
    lastUpdated.value = new Date().toLocaleTimeString()
  } catch (err) {
    // 拉取失败：仅提示，保留上一次成功的数据
    ElMessage.error(`加载仪表盘数据失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    loading.value = false
  }
}

// 自动刷新定时器句柄（组件卸载时清理）
let timer: number | undefined

onMounted(() => {
  void load()
  // 每 30 秒自动刷新一次
  timer = window.setInterval(() => {
    void load()
  }, 30_000)
})

onUnmounted(() => {
  // 卸载时清理定时器，避免泄漏
  if (timer !== undefined) {
    window.clearInterval(timer)
  }
})
</script>

<template>
  <div class="dashboard">
    <!-- 顶部工具条：标题 + 最后更新时间 + 手动刷新按钮 -->
    <div class="dashboard-toolbar">
      <h2 class="dashboard-title">Dashboard</h2>
      <div class="dashboard-actions">
        <span v-if="lastUpdated" class="last-updated">Last updated: {{ lastUpdated }}</span>
        <el-button :icon="Refresh" :loading="loading" @click="load">Refresh</el-button>
      </div>
    </div>

    <!-- 4 张指标卡片：响应式栅格（≥1200px 一行 4 张，小屏逐行换列） -->
    <el-row :gutter="16">
      <el-col :xs="24" :sm="12" :lg="6">
        <el-card shadow="hover">
          <el-statistic title="Active Upstreams" :value="activeUpstreams" />
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :lg="6">
        <el-card shadow="hover">
          <el-statistic title="Total Models" :value="totalModels" />
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :lg="6">
        <el-card shadow="hover">
          <!-- 请求数：进程启动以来累计（内存统计），副标题注明起点 -->
          <el-statistic title="Requests (since process start)" :value="requests" />
          <div class="card-subtitle">since {{ since }}</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :lg="6">
        <el-card shadow="hover">
          <!-- 错误率：errors / requests；无请求时显示 "—" -->
          <el-statistic title="Error Rate (since process start)" :value="errorRate" :formatter="() => errorRateText" />
          <div class="card-subtitle">since {{ since }}</div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
/* 页面容器与工具条布局 */
.dashboard {
  padding: 16px;
}

.dashboard-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.dashboard-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.dashboard-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.last-updated {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* 卡片副标题：统计口径起点说明 */
.card-subtitle {
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>

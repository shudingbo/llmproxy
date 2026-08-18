<script setup lang="ts">
// 仪表盘页：4 张指标卡片（活跃上游 / 模型总数 / 请求数 / 错误率） + 下游 API 列表
// 数据来源：upstreams（活跃数）、downstream-models（别名数）、stats（进程启动以来的请求与错误）、
//           /admin/api/health.downstreams（与 server 启动日志同源的端点清单）
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

// 下游端点条目：与 server/src/server/downstreams.ts 一一对应
interface DownstreamEndpoint {
  type: 'openai' | 'ollama' | 'admin'
  method: string
  path: string
  summary: string
}

// health 接口响应：原样覆盖后端 /admin/api/health 的字段
interface HealthResponse {
  status: string
  uptime: number
  version: string
  downstreams: DownstreamEndpoint[]
  host: string
  port: number
  baseUrl: string
  listenSource: 'env' | 'config' | 'default'
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
const downstreams = ref<DownstreamEndpoint[]>([])
// 当前进程生效的下行流入口；初始为空，拉取 /admin/api/health 后填充
const baseUrl = ref('')
const listenSource = ref<HealthResponse['listenSource']>('default')

// 类型 → Element Plus tag 颜色映射：openai 主色（primary）、ollama 成功色（success）、admin 信息色（info）
const typeTagType = (type: DownstreamEndpoint['type']): 'primary' | 'success' | 'info' => {
  if (type === 'openai') return 'primary'
  if (type === 'ollama') return 'success'
  return 'info'
}

// 类型 → 中文展示名
const typeLabel = (type: DownstreamEndpoint['type']): string => {
  if (type === 'openai') return 'OpenAI 兼容'
  if (type === 'ollama') return 'Ollama 兼容'
  return '管理端'
}

// listenSource → 用户可读来源标签
const sourceLabel = (s: HealthResponse['listenSource']): string => {
  if (s === 'env') return '环境变量'
  if (s === 'config') return '配置文件'
  return '缺省'
}

// listenSource → Element Plus tag 颜色映射：env 偏警告（罕见）、config 主色、default 信息色
const listenSourceTagType = (s: HealthResponse['listenSource']): 'warning' | 'primary' | 'info' => {
  if (s === 'env') return 'warning'
  if (s === 'config') return 'primary'
  return 'info'
}

// 按下游类型分组：openai / ollama / admin 三个分块展示
const downstreamsByType = computed(() => {
  const map: Record<DownstreamEndpoint['type'], DownstreamEndpoint[]> = { openai: [], ollama: [], admin: [] }
  for (const ep of downstreams.value) {
    map[ep.type].push(ep)
  }
  return map
})

// 错误率文本：无请求时显示占位符 "—"
const errorRateText = computed(() => {
  if (!errorRateValid.value) {
    return '—'
  }
  return `${errorRate.value.toFixed(2)}%`
})

// 异步加载全部卡片数据：四个接口并发请求，任一失败即整体报错（ElMessage 提示）
async function load(): Promise<void> {
  loading.value = true
  try {
    const [upstreamsRes, modelsRes, statsRes, healthRes] = await Promise.all([
      api.get<Upstream[]>('/upstreams'),
      api.get<Record<string, unknown>>('/downstream-models'),
      api.get<StatsResponse>('/stats'),
      api.get<HealthResponse>('/health'),
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
    // 下游 API 列表：与 server 启动日志同一份数据
    downstreams.value = healthRes.data.downstreams
    // 当前进程生效的下行流入口（http://host:port）
    baseUrl.value = healthRes.data.baseUrl
    listenSource.value = healthRes.data.listenSource
    lastUpdated.value = new Date().toLocaleTimeString()
  } catch (err) {
    // 拉取失败：仅提示，保留上一次成功的数据
    ElMessage.error(`加载仪表盘数据失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    loading.value = false
  }
}

const isLinkPath = (path: string): boolean => {
  const linkPaths = ['api/tags', '/api/version', '/v1/models'];
  for( const linkPath of linkPaths) {
    if (path.indexOf(linkPath) !== -1) {
      return true
    }
  }

  return false
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

    <!-- 下游 API 列表：每类下游一张表（openai / ollama / admin），与 server 启动日志同源 -->
    <div class="downstreams-section">
      <div class="section-header">
        <h3 class="section-title">Downstream Endpoints</h3>
        <!-- 当前进程生效的下行流入口 + 来源标签：方便运维一眼看到访问地址与生效来源 -->
        <div v-if="baseUrl" class="base-url-pill" :title="`来源：${sourceLabel(listenSource)}`">
          <span class="base-url-label">Base URL</span>
          <CopyText class="alias-title" :copy-text="baseUrl">
            <a :href="baseUrl" target="_blank" class="base-url-value">{{ baseUrl }}</a>
          </CopyText>
        </div>
      </div>
      <el-row :gutter="16">
        <el-col v-for="type in (['openai', 'ollama', 'admin'] as const)" :key="type" :xs="24" :lg="8">
          <el-card shadow="hover" class="downstream-card">
            <template #header>
              <div class="card-header">
                <el-tag :type="typeTagType(type)" size="small">{{ typeLabel(type) }}</el-tag>
                <span class="endpoint-count">{{ downstreamsByType[type].length }} endpoints</span>
              </div>
            </template>
            <el-table :data="downstreamsByType[type]" size="small" border>
              <el-table-column label="Method" width="80">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain">{{ row.method }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="Path" min-width="180">
                <template #default="{ row }">
                    <a v-if="isLinkPath(row.path)" class="path-code" :href="baseUrl + row.path" target="_blank">{{ row.path }}</a>
                   <code v-else class="path-code">{{ row.path }}</code>
                </template>
              </el-table-column>
              <el-table-column label="Description" min-width="200">
                <template #default="{ row }">
                  <span class="endpoint-summary">{{ row.summary }}</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>
    </div>
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

/* 下游区段：与上方卡片留出间距 */
.downstreams-section {
  margin-top: 24px;
}

/* 段头容器：标题 + baseUrl pill 并排 */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

/* Base URL 胶囊：左侧标签 + 中间 URL + 右侧来源角标，单行可点选复制 */
.base-url-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  user-select: all;
}

.base-url-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 600;
}

.base-url-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--el-color-primary);
}

.downstream-card {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.endpoint-count {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.path-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-color-primary);
  background-color: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
}

.endpoint-summary {
  color: var(--el-text-color-regular);
  font-size: 11px;
}
</style>

<template>
  <div class="logs-page">
    <!-- 筛选栏：日期 / 级别 / 关键词 -->
    <div class="filter-bar">
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
      <el-select v-model="level" placeholder="级别">
        <el-option v-for="opt in levelOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <el-input v-model="keyword" placeholder="关键词过滤（msg 子串，大小写敏感）" clearable class="keyword-input" />
    </div>

    <!-- 日志表格：有数据（或加载中）时显示，否则显示空状态 -->
    <template v-if="lines.length > 0 || loading">
      <el-table :data="pagedLines" v-loading="loading" border stripe size="small" height="calc(100vh - 260px)">
        <el-table-column label="Time" width="180">
          <template #default="{ row }">{{ formatTime(row.time) }}</template>
        </el-table-column>
        <el-table-column label="Level" width="90">
          <template #default="{ row }">
            <el-tag :type="levelTag(row.level)" size="small" effect="dark">{{ levelLabel(row.level) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Request ID" width="140">
          <template #default="{ row }">
            <code class="req-id">{{ shortReqId(row.requestId) }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Message" min-width="400">
          <template #default="{ row }">{{ messageText(row as LogLine) }}</template>
        </el-table-column>
      </el-table>

      <!-- 分页：后端最多返回 1000 条，内存分页展示 -->
      <div class="pager">
        <el-pagination
          v-if="lines.length > pageSize"
          layout="total, prev, pager, next"
          :total="lines.length"
          :page-size="pageSize"
          :current-page="currentPage"
          @current-change="currentPage = $event"
        />
      </div>
    </template>
    <el-empty v-else description="暂无日志" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../api/client'

// pino 级别数值 → 展示标签映射（trace=10 debug=20 info=30 warn=40 error=50 fatal=60）
const LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

// pino 级别数值 → el-tag 类型：info=蓝 warn=橙 error=红 debug=绿 trace=灰 fatal=红
const LEVEL_TAGS: Record<number, 'primary' | 'success' | 'info' | 'warning' | 'danger'> = {
  10: 'info',
  20: 'success',
  30: 'primary',
  40: 'warning',
  50: 'danger',
  60: 'danger',
}

// 后端返回的单条日志结构（pino JSON 行的子集，其余字段忽略）
interface LogLine {
  level: number
  time: number
  msg?: string
  requestId?: string
  method?: string
  url?: string
  status?: number
  [key: string]: unknown
}

// 取本地时区的 YYYY-MM-DD 字符串
function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 筛选状态：日期默认今天，级别默认 all（全部）
const date = ref(localDate(new Date()))
const level = ref('all')
const keyword = ref('')

// 级别下拉选项
const levelOptions = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((v) => ({
  value: v,
  label: v,
}))

const lines = ref<LogLine[]>([])
const loading = ref(false)
// 手动筛选变更标记：为 true 时跳过自动刷新，避免覆盖用户正在编辑的查询
const manualDirty = ref(false)

// 内存分页（后端最多返回 1000 条）
const pageSize = 100
const currentPage = ref(1)
const pagedLines = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return lines.value.slice(start, start + pageSize)
})

// 拉取日志：date 必填；level='all' 时显式传 trace（最低阈值）以包含全部级别。
// 注意：后端缺省 level 会默认 info，直接省略会导致 debug/trace 被过滤掉。
async function fetchLogs(): Promise<void> {
  loading.value = true
  try {
    const params: Record<string, string> = { date: date.value }
    params.level = level.value === 'all' ? 'trace' : level.value
    if (keyword.value.trim() !== '') {
      params.keyword = keyword.value.trim()
    }
    const res = await api.get<{ lines: LogLine[] }>('/logs', { params })
    lines.value = res.data.lines
    currentPage.value = 1
  } catch (err) {
    // 拉取失败保留旧数据，只输出控制台警告（不打印文件内容）
    console.warn('拉取日志失败', err)
  } finally {
    loading.value = false
    manualDirty.value = false
  }
}

// 筛选变化 → 防抖 300ms 后重新拉取（关键词逐字输入时不发请求风暴）
let debounceTimer: number | undefined
watch([date, level, keyword], () => {
  manualDirty.value = true
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    fetchLogs()
  }, 300)
})

// 自动刷新：每 5 秒一次；手动筛选未完成或有请求在途时跳过
let refreshTimer: number | undefined
onMounted(() => {
  fetchLogs()
  refreshTimer = window.setInterval(() => {
    if (!manualDirty.value && !loading.value) {
      fetchLogs()
    }
  }, 5000)
})

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
})

// ---- 展示辅助 ----

// 时间列：pino ISO 时间戳（epoch 毫秒）转本地可读格式
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function levelLabel(n: number): string {
  return LEVEL_LABELS[n] ?? String(n)
}

function levelTag(n: number): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  return LEVEL_TAGS[n] ?? 'info'
}

// Request ID 列：取前 8 位短格式
function shortReqId(id: string | undefined): string {
  if (id === undefined || id === '') return '-'
  return id.slice(0, 8)
}

// 消息列：请求完成行附带 method/url/status 上下文，其余行只显示 msg
function messageText(line: LogLine): string {
  const base = line.msg ?? ''
  if (line.method !== undefined && line.url !== undefined && line.status !== undefined) {
    return `${base} ${line.method} ${line.url} -> ${line.status}`
  }
  return base
}
</script>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

/* 筛选栏：日期 / 级别 / 关键词 横向排列 */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.filter-bar .el-select {
  width: 120px;
}

.keyword-input {
  width: 260px;
}

/* Request ID 用等宽字体弱化显示 */
.req-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 分页靠右 */
.pager {
  display: flex;
  justify-content: flex-end;
}
</style>

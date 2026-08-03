<template>
  <div class="logs-page">
    <!-- 筛选栏：类型 / 日期 / 级别 / 关键词 -->
    <div class="filter-bar">
      <el-radio-group v-model="logType" size="small">
        <el-radio-button value="app">App 日志</el-radio-button>
        <el-radio-button value="api">API 日志</el-radio-button>
      </el-radio-group>
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
      <el-select v-model="level" placeholder="级别">
        <el-option v-for="opt in levelOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <el-input v-model="keyword" placeholder="关键词过滤（msg 子串，大小写敏感）" clearable class="keyword-input" />
    </div>

    <!-- 浏览位置提示 -->
    <div v-if="browsingHistory" class="history-banner">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>
          正在查看历史日志，自动刷新已暂停
        </template>
      </el-alert>
      <div class="history-actions">
        <el-button type="primary" size="small" @click="goToLatest">
          回到最新
        </el-button>
      </div>
    </div>

    <!-- 日志表格：有数据（或加载中）时显示，否则显示空状态 -->
    <template v-if="lines.length > 0 || loading">
      <el-table :data="lines" v-loading="loading" border stripe size="small" height="calc(100vh - 300px)">
        <el-table-column label="Time" width="180">
          <template #default="{ row }">{{ formatTime(row.time) }}</template>
        </el-table-column>
        <el-table-column label="Level" width="90">
          <template #default="{ row }">
            <el-tag :type="levelTag(row.level)" size="small" effect="dark">{{ levelLabel(row.level) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="logType === 'app' ? 'Category' : 'Request ID'" width="140">
          <template #default="{ row }">
            <code class="req-id">{{ logType === 'app' ? (row.category ?? '-') : shortReqId(row.requestId) }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Message" min-width="400">
          <template #default="{ row }">{{ messageText(row as LogLine) }}</template>
        </el-table-column>
      </el-table>

      <!-- 后端分页控制 -->
      <div class="pager">
        <span class="page-info" v-if="browsingHistory">
          查看第 {{ pageCount }} 页（更早日志）
        </span>
        <span class="page-info" v-else>
          最新日志
        </span>
        <el-button
          :disabled="!hasMore || loading"
          size="small"
          @click="loadNextPage"
        >
          下一页
        </el-button>
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
// app 日志：time 为字符串 (ISO)，有 category，无 requestId
// api 日志：time 为数字 (epoch ms)，有 requestId/method/url/status
interface LogLine {
  level: number
  time: number | string
  msg?: string
  requestId?: string
  method?: string
  url?: string
  status?: number
  category?: string
  [key: string]: unknown
}

// 后端分页响应
interface LogsResponse {
  lines: LogLine[]
  type: string
  offset?: number
  limit?: number
  hasMore?: boolean
  scanned?: number
}

const PAGE_LIMIT = 100

// 取本地时区的 YYYY-MM-DD 字符串
function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 筛选状态：日期默认今天，级别默认 all（全部），类型默认 app
const logType = ref<'app' | 'api'>('app')
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

// 后端分页状态
const offset = ref(0)
const hasMore = ref(false)

// 是否在浏览历史日志（offset > 0）
const browsingHistory = computed(() => offset.value > 0)

// 当前页码（仅展示用）
const pageCount = computed(() => Math.floor(offset.value / PAGE_LIMIT) + 1)

// 拉取日志：date 必填；level='all' 时显式传 trace（最低阈值）以包含全部级别。
// 注意：后端缺省 level 会默认 info，直接省略会导致 debug/trace 被过滤掉。
async function fetchLogs(): Promise<void> {
  loading.value = true
  try {
    const params: Record<string, string> = {
      date: date.value,
      type: logType.value,
      offset: String(offset.value),
      limit: String(PAGE_LIMIT),
    }
    params.level = level.value === 'all' ? 'trace' : level.value
    if (keyword.value.trim() !== '') {
      params.keyword = keyword.value.trim()
    }
    const res = await api.get<LogsResponse>('/logs', { params })
    lines.value = res.data.lines

    // 读取 hasMore：后端返回则用后端值；未返回时按返回条数推断
    if (res.data.hasMore !== undefined) {
      hasMore.value = res.data.hasMore
    } else {
      hasMore.value = res.data.lines.length >= PAGE_LIMIT
    }
  } catch (err) {
    // 拉取失败保留旧数据，只输出控制台警告（不打印文件内容）
    console.warn('拉取日志失败', err)
  } finally {
    loading.value = false
    manualDirty.value = false
  }
}

// 筛选变化 → 重置 offset=0，防抖 300ms 后重新拉取（关键词逐字输入时不发请求风暴）
let debounceTimer: number | undefined
watch([logType, date, level, keyword], () => {
  manualDirty.value = true
  offset.value = 0
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    fetchLogs()
  }, 300)
})

// 自动刷新：每 5 秒一次；仅 offset=0（最新日志）时刷新
// 手动筛选未完成或有请求在途时跳过
let refreshTimer: number | undefined
onMounted(() => {
  fetchLogs()
  refreshTimer = window.setInterval(() => {
    if (!manualDirty.value && !loading.value && offset.value === 0) {
      fetchLogs()
    }
  }, 5000)
})

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
})

// ---- 分页操作 ----

// 加载下一页（offset += lines.length）
function loadNextPage(): void {
  offset.value += lines.value.length
  fetchLogs()
}

// 回到最新（offset=0）
function goToLatest(): void {
  offset.value = 0
  fetchLogs()
}

// ---- 展示辅助 ----

// 时间列：app 日志 time 为字符串 (HH 为字面量占位，替换为 00 再解析)，api 日志 time 为数字 (epoch ms)
function formatTime(ts: number | string): string {
  if (typeof ts === 'string') {
    ts = ts.replace('HH', '00')
  }
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

/* 浏览历史提示横幅 */
.history-banner {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-actions {
  display: flex;
  justify-content: flex-end;
}

/* 分页控制 */
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.page-info {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>

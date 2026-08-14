<template>
  <div class="sessions-page">
    <!-- 筛选栏：客户端下拉 / 关键字 / 操作按钮组 -->
    <div class="filter-bar">
      <el-select v-model="client" placeholder="客户端" clearable class="client-select">
        <el-option v-for="opt in clientOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="关键字（session_id 或 upstream_id）"
        clearable
        class="keyword-input"
        @keyup.enter="reload"
      />
      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      <div class="filter-spacer" />
      <el-button type="warning" :icon="Brush" :loading="cleaning" @click="cleanup">立即清理</el-button>
      <el-button type="danger" :icon="Delete" @click="clearAll">清空全部</el-button>
    </div>

    <!-- 会话表格：有数据或加载中时显示表格，否则显示空状态 -->
    <template v-if="rows.length > 0 || loading">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
      >
        <el-table-column label="会话 ID" min-width="100">
          <template #default="{ row }">
            <span class="session-id" :title="row.session_id">{{ row.session_id.substring(0, 10) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="会话键" min-width="240">
          <template #default="{ row }">
            <code class="code" :title="row.session_key">{{ row.session_key.substring(0, 32) }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Client" width="140">
          <template #default="{ row }">
            <el-tag :type="clientTag(row.client)" :color="clientColor(row.client)" size="small" effect="dark">{{ row.client }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="虚拟模型" min-width="160">
          <template #default="{ row }">
            <span class="model" :title="row.downstream_model">{{ row.downstream_model }}</span>
          </template>
        </el-table-column>
        <el-table-column label="粘附上游" min-width="200">
          <template #default="{ row }">
            <div class="upstream-cell">
              <span class="upstream-id">{{ row.upstream_id }}</span>
              <span class="upstream-model">{{ row.upstream_model }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" @click="removeOne(row as SessionRow)">解绑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 服务端分页：total 来自响应，page 变化重置 offset 重新请求 -->
      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="limit"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </template>
    <el-empty v-else description="暂无会话映射" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Brush, Delete, Search } from '@element-plus/icons-vue'
import { api } from '../api/client'

// 会话粘附映射行（后端 SQLite 持久化）
interface SessionRow {
  session_key: string
  session_id: string
  client: string
  downstream_model: string
  upstream_id: string
  upstream_model: string
  created_at: number
  updated_at: number
}

// 列表响应
interface SessionListResponse {
  rows: SessionRow[]
  total: number
}

// 客户端列表（从接口动态获取）
const clientList = ref<string[]>([])

// 客户端下拉选项：空串表示全部
const clientOptions = computed(() => [
  { value: '', label: '全部' },
  ...clientList.value.map(c => ({ value: c, label: c })),
])

const rows = ref<SessionRow[]>([])
const total = ref(0)
const loading = ref(false)
const cleaning = ref(false)

const client = ref('') // 客户端筛选
const keyword = ref('') // 关键字（session_id / upstream_id）
const page = ref(1)
const limit = ref(20)
const offset = ref(0)

// 客户端类型 → el-tag 颜色：open-webui=蓝、x-session-id=深蓝、ywnrs=紫、content-hash=绿、unknown/github=橙，其余=灰
function clientTag(c: string): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  switch (c) {
    case 'open-webui':
      return 'primary'
    case 'x-session-id':
      return 'info'
    case 'ywnrs':
      return 'danger'
    case 'content-hash':
      return 'success'
    case 'unknown':
    case 'github':
      return 'warning'
    default:
      return 'info'
  }
}

// opencode 专属 tag 底色（其余类型走 clientTag 的语义色，这里返回 undefined 交由 type 决定）
function clientColor(c: string): string | undefined {
  if (c === 'opencode') {
    return '#2d6cdf'
  }
  return undefined
}

// epoch ms → 本地时间字符串（参考 Logs.vue 的 formatTime）
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

// 拉取客户端列表（GET /admin/api/session-clients）
async function fetchClients(): Promise<void> {
  try {
    const { data } = await api.get<{ clients: string[] }>('/session-clients')
    clientList.value = data.clients
  } catch (err: any) {
    ElMessage.error(`加载客户端列表失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 拉取列表（GET /admin/api/sessions）
async function fetchList(): Promise<void> {
  loading.value = true
  try {
    const params: Record<string, string> = {
      offset: String(offset.value),
      limit: String(limit.value),
    }
    if (client.value !== '') params.client = client.value
    if (keyword.value.trim() !== '') params.keyword = keyword.value.trim()
    const { data } = await api.get<SessionListResponse>('/sessions', { params })
    rows.value = data.rows
    total.value = data.total
  } catch (err: any) {
    ElMessage.error(`加载失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    loading.value = false
  }
}

// 手动查询（按钮 / 回车）：重置到第一页
function reload(): void {
  page.value = 1
  offset.value = 0
  fetchList()
}

// 分页切换
function handlePageChange(p: number): void {
  page.value = p
  offset.value = (p - 1) * limit.value
  fetchList()
}

// 每页大小切换
function handleSizeChange(s: number): void {
  limit.value = s
  page.value = 1
  offset.value = 0
  fetchList()
}

// 单条解绑
async function removeOne(row: SessionRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认解绑会话「${row.session_id}」？删除后该会话下次请求将重新选择上游。`,
      '解绑确认',
      { type: 'warning', confirmButtonText: '解绑', cancelButtonText: '取消' },
    )
    const { data } = await api.delete<{ deleted: boolean }>(
      `/sessions/${encodeURIComponent(row.session_key)}`,
    )
    if (data.deleted) {
      ElMessage.success('已解绑')
    } else {
      ElMessage.warning('会话不存在或已删除')
    }
    await fetchList()
  } catch (err: any) {
    // 用户取消时不提示
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(`解绑失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 清空全部（危险操作）
async function clearAll(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '确认清空全部会话粘附映射？此操作不可恢复，所有会话下次请求都将重新选上游。',
      '清空确认',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
    const { data } = await api.delete<{ deleted: number }>('/sessions')
    ElMessage.success(`已清空 ${data.deleted} 条会话`)
    page.value = 1
    offset.value = 0
    await fetchList()
  } catch (err: any) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(`清空失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 立即清理（POST /admin/api/sessions/cleanup，触发后端清理逻辑并返回本次删除数）
async function cleanup(): Promise<void> {
  cleaning.value = true
  try {
    const { data } = await api.post<{ deleted: number }>('/sessions/cleanup')
    ElMessage.success(`清理完成，共删除 ${data.deleted} 条会话`)
    await fetchList()
  } catch (err: any) {
    ElMessage.error(`清理失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    cleaning.value = false
  }
}

// 筛选变化 → 防抖 300ms 重新查询（避免关键词逐字输入时请求风暴）
let debounceTimer: number | undefined
watch([client, keyword], () => {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    page.value = 1
    offset.value = 0
    fetchList()
  }, 300)
})

onMounted(async () => {
  await fetchClients()
  await fetchList()
})
</script>

<style scoped>
.sessions-page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 筛选栏：横向排列，靠左筛选 / 靠右操作 */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.filter-spacer {
  flex: 1;
}

.client-select {
  width: 160px;
}

.keyword-input {
  width: 280px;
}

/* 等宽字体：会话 ID / 会话键 / 模型名 */
.code {
  font-family: monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.session-id {
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}

.model {
  font-family: monospace;
  font-size: 12px;
}

/* 上游单元格：id 加粗，模型名次级文字 */
.upstream-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.upstream-id {
  font-weight: 600;
}

.upstream-model {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-family: monospace;
}

/* 分页控件：右对齐 */
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>

<template>
  <div class="api-keys-page">
    <!-- 顶部状态卡片：开关 + Key 总数 -->
    <div class="status-bar">
      <div class="status-text">
        <span class="label">鉴权状态</span>
        <el-tag :type="authEnabled ? 'success' : 'info'" size="small">
          {{ authEnabled ? '已开启' : '已关闭' }}
        </el-tag>
      </div>
      <div class="status-text">
        <span class="label">Key 数</span>
        <span class="value">{{ total }}</span>
      </div>
      <div class="status-spacer" />
      <el-button type="primary" :icon="Plus" @click="openCreate">新建 API Key</el-button>
    </div>

    <!-- 筛选栏：关键字 + 包含停用 -->
    <div class="filter-bar">
      <el-input
        v-model="keyword"
        placeholder="关键字（按名称 / 前缀匹配）"
        clearable
        class="keyword-input"
        @keyup.enter="reload"
      />
      <el-checkbox v-model="includeDisabled">包含已停用</el-checkbox>
      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
    </div>

    <!-- API Key 列表表格 -->
    <template v-if="rows.length > 0 || loading">
      <el-table v-loading="loading" :data="rows" border stripe size="small">
        <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="前缀" min-width="160">
          <template #default="{ row }">
            <code class="prefix">{{ row.keyPrefix }}…</code>
          </template>
        </el-table-column>
        <el-table-column label="过期时间" min-width="180">
          <template #default="{ row }">{{ formatExpiry(row.expiresAt) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row)" size="small">
              {{ statusLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row as ApiKeyItem)">编辑</el-button>
            <el-button
              size="small"
              :type="row.disabled ? 'success' : 'warning'"
              @click="toggleDisabled(row as ApiKeyItem)"
            >
              {{ row.disabled ? '启用' : '停用' }}
            </el-button>
            <el-button size="small" type="danger" @click="removeKey(row as ApiKeyItem)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
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
    <el-empty v-else description="暂无 API Key" />

    <!-- 新建弹窗：name 必填，过期时间可选（0 = 永不过期） -->
    <el-dialog
      v-model="createVisible"
      title="新建 API Key"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetCreateForm"
    >
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="createForm.name" placeholder="如 open-webui-prod" />
        </el-form-item>
        <el-form-item label="过期时间" prop="expiresAt">
          <!-- 永不过期开关：开启后 expiresAt 强制 0；关闭后由日期选择器填具体时间 -->
          <div class="expiry-row">
            <el-switch v-model="createForm.neverExpire" active-text="永不过期" />
            <el-date-picker
              v-if="!createForm.neverExpire"
              v-model="createForm.expiresAt"
              type="datetime"
              placeholder="选择过期时间"
              value-format="x"
              class="expiry-picker"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 创建结果展示：明文 Key 仅此一次可见，提示用户复制保存 -->
    <el-dialog
      v-model="createdVisible"
      title="API Key 已创建"
      width="540px"
      :close-on-click-modal="false"
      @closed="onCreatedDialogClosed"
    >
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>
          请立即复制并妥善保存该 Key，关闭后将无法再次查看明文。
        </template>
      </el-alert>
      <div class="created-key-box">
        <code class="created-key">{{ createdKey }}</code>
        <el-button type="primary" :icon="CopyDocument" @click="copyCreatedKey">复制</el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="createdVisible = false">我已保存</el-button>
      </template>
    </el-dialog>

    <!-- 编辑弹窗：name / expiresAt 修改 -->
    <el-dialog
      v-model="editVisible"
      title="编辑 API Key"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetEditForm"
    >
      <el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="editForm.name" placeholder="名称" />
        </el-form-item>
        <el-form-item label="过期时间" prop="expiresAt">
          <div class="expiry-row">
            <el-switch v-model="editForm.neverExpire" active-text="永不过期" />
            <el-date-picker
              v-if="!editForm.neverExpire"
              v-model="editForm.expiresAt"
              type="datetime"
              placeholder="选择过期时间"
              value-format="x"
              class="expiry-picker"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { CopyDocument, Plus, Search } from '@element-plus/icons-vue'
import { api } from '../api/client'

// API Key 行（列表/编辑用，hash 字段不暴露）
interface ApiKeyItem {
  id: number
  name: string
  keyPrefix: string
  expiresAt: number
  disabled: number // 0/1；UI 渲染时转 boolean
  createdAt: number
}

// 创建表单：neverExpire 切换 expiresAt 来源；neverExpire=true 时 expiresAt 失效
interface CreateForm {
  name: string
  neverExpire: boolean
  expiresAt: number // epoch ms；neverExpire=true 时忽略
}

// 编辑表单：结构与 CreateForm 一致
interface EditForm {
  name: string
  neverExpire: boolean
  expiresAt: number
}

const loading = ref(false)
const rows = ref<ApiKeyItem[]>([])
const total = ref(0)
const page = ref(1)
const limit = ref(20)
const keyword = ref('')
const includeDisabled = ref(false)
const authEnabled = ref(false)

// 新建
const createVisible = ref(false)
const creating = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive<CreateForm>({
  name: '',
  neverExpire: true,
  expiresAt: 0,
})
const createRules = reactive<FormRules>({
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
})

// 创建结果
const createdVisible = ref(false)
const createdKey = ref('')

// 编辑
const editVisible = ref(false)
const saving = ref(false)
const editFormRef = ref<FormInstance>()
const editingId = ref<number | null>(null)
const editForm = reactive<EditForm>({
  name: '',
  neverExpire: true,
  expiresAt: 0,
})
const editRules = reactive<FormRules>({
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
})

// 计算偏移：第 page 页从 (page-1)*limit 开始
const offset = (): number => (page.value - 1) * limit.value

// 时间格式化
const formatTime = (ts: number): string => {
  if (!ts || ts <= 0) return '-'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', { hour12: false })
}

// 过期时间显示：0 表示永不过期；负值 / 已过期标红
const formatExpiry = (ts: number): string => {
  if (ts === 0) return '永不过期'
  const d = new Date(ts)
  const formatted = d.toLocaleString('zh-CN', { hour12: false })
  return ts < Date.now() ? `${formatted}（已过期）` : formatted
}

// 状态：综合 disabled + 过期计算 UI tag 类型与文案
// 参数用 ApiKeyItem | Record<string, unknown>，兼容 Element Plus 表格 row 推断（DefaultRow）缺失字段；
// 内部用 (row as ApiKeyItem) 收敛为强类型
const statusType = (row: ApiKeyItem | Record<string, unknown>): 'success' | 'info' | 'warning' | 'danger' => {
  const r = row as ApiKeyItem
  if (r.disabled) return 'info'
  if (r.expiresAt !== 0 && r.expiresAt < Date.now()) return 'danger'
  return 'success'
}
const statusLabel = (row: ApiKeyItem | Record<string, unknown>): string => {
  const r = row as ApiKeyItem
  if (r.disabled) return '已停用'
  if (r.expiresAt !== 0 && r.expiresAt < Date.now()) return '已过期'
  return '正常'
}

// 拉取鉴权状态
async function fetchAuthStatus() {
  try {
    const { data } = await api.get<{ enabled: boolean; total: number }>('/auth/status')
    authEnabled.value = data.enabled
  } catch (err: any) {
    ElMessage.error(`加载鉴权状态失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 拉取列表
async function fetchKeys() {
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      offset: offset(),
      limit: limit.value,
    }
    if (keyword.value.trim() !== '') params.keyword = keyword.value.trim()
    if (includeDisabled.value) params.includeDisabled = true
    const { data } = await api.get<{ rows: ApiKeyItem[]; total: number }>('/keys', { params })
    rows.value = data.rows
    total.value = data.total
  } catch (err: any) {
    ElMessage.error(`加载 API Key 列表失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    loading.value = false
  }
}

// 重载（重置 page=1）
async function reload() {
  page.value = 1
  await fetchKeys()
}

// 翻页：page 改变时直接重取（offset 已通过 offset() 计算）
async function handlePageChange() {
  await fetchKeys()
}
async function handleSizeChange() {
  // size 变化时回到第 1 页
  page.value = 1
  await fetchKeys()
}

// 打开新建弹窗
function openCreate() {
  createVisible.value = true
}
function resetCreateForm() {
  createForm.name = ''
  createForm.neverExpire = true
  createForm.expiresAt = 0
  createFormRef.value?.clearValidate()
}

// 提交新建：成功后弹出明文一次
async function submitCreate() {
  await createFormRef.value?.validate()
  creating.value = true
  try {
    const payload: Record<string, unknown> = {
      name: createForm.name,
    }
    payload.expiresAt = createForm.neverExpire ? 0 : Number(createForm.expiresAt)
    const { data } = await api.post<ApiKeyItem & { apiKey: string }>('/keys', payload)
    createdKey.value = data.apiKey
    createVisible.value = false
    createdVisible.value = true
    await fetchKeys()
    await fetchAuthStatus()
  } catch (err: any) {
    ElMessage.error(`创建失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    creating.value = false
  }
}

// 复制创建的明文 Key 到剪贴板
async function copyCreatedKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value)
    ElMessage.success('已复制')
  } catch {
    // 降级：手动复制提示
    ElMessage.warning('自动复制失败，请手动选择文本复制')
  }
}

// 关闭创建结果弹窗时清空明文，避免后续误显示
function onCreatedDialogClosed() {
  createdKey.value = ''
}

// 打开编辑弹窗：编辑模式 expiresAt=0 时切换 neverExpire=true
function openEdit(row: ApiKeyItem) {
  editingId.value = row.id
  editForm.name = row.name
  editForm.neverExpire = row.expiresAt === 0
  editForm.expiresAt = row.expiresAt
  editVisible.value = true
}
function resetEditForm() {
  editingId.value = null
  editForm.name = ''
  editForm.neverExpire = true
  editForm.expiresAt = 0
  editFormRef.value?.clearValidate()
}

// 提交编辑
async function submitEdit() {
  await editFormRef.value?.validate()
  saving.value = true
  try {
    const payload: Record<string, unknown> = {
      name: editForm.name,
    }
    payload.expiresAt = editForm.neverExpire ? 0 : Number(editForm.expiresAt)
    await api.put(`/keys/${editingId.value}`, payload)
    ElMessage.success('已保存')
    editVisible.value = false
    await fetchKeys()
  } catch (err: any) {
    ElMessage.error(`保存失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    saving.value = false
  }
}

// 切换停用 / 启用：仅下发 disabled 字段
async function toggleDisabled(row: ApiKeyItem) {
  try {
    await api.put(`/keys/${row.id}`, { disabled: row.disabled === 1 })
    ElMessage.success(row.disabled === 1 ? '已启用' : '已停用')
    await fetchKeys()
  } catch (err: any) {
    ElMessage.error(`操作失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 删除：弹确认后调用
async function removeKey(row: ApiKeyItem) {
  try {
    await ElMessageBox.confirm(`确认删除 API Key「${row.name}」？使用该 Key 的客户端将立即鉴权失败。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await api.delete(`/keys/${row.id}`)
    ElMessage.success('已删除')
    await fetchKeys()
  } catch (err: any) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(`删除失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 监听筛选条件：includeDisabled / keyword 变化自动重载（debounce 由 Element Plus 的 clearable 处理）
watch([includeDisabled], () => {
  reload()
})

onMounted(async () => {
  await fetchAuthStatus()
  await fetchKeys()
})
</script>

<style scoped>
.api-keys-page {
  padding: 16px;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 6px;
}

.status-text {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-text .label {
  color: #606266;
  font-size: 13px;
}

.status-text .value {
  font-weight: 600;
  font-size: 14px;
}

.status-spacer {
  flex: 1;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.keyword-input {
  width: 280px;
}

.prefix {
  font-family: monospace;
  color: #606266;
}

.expiry-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.expiry-picker {
  flex: 1;
}

.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.created-key-box {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 4px;
}

.created-key {
  flex: 1;
  font-family: monospace;
  font-size: 13px;
  word-break: break-all;
  color: #d63384;
}
</style>
<template>
  <div class="upstreams-page">
    <!-- 顶部工具栏：新增按钮 -->
    <div class="toolbar">
      <el-button type="primary" :icon="Plus" @click="openCreate">新增上游</el-button>
    </div>

    <!-- 上游列表：暂停的行灰底 + Paused 标签，不隐藏 -->
    <el-table
      v-loading="loading"
      :data="upstreams"
      :row-class-name="rowClassName"
      border
      stripe
    >
      <el-table-column prop="id" label="ID" min-width="120" />
      <el-table-column label="Base URL" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="base-url">{{ row.baseUrl }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Type" width="100">
        <template #default>
          <el-tag type="info" size="small">openai</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Status" width="120">
        <template #default="{ row }">
          <!-- 状态：disabled → Paused（灰），否则 Healthy（绿） -->
          <el-tag :type="row.disabled ? 'info' : 'success'" size="small">
            {{ row.disabled ? 'Paused' : 'Healthy' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Disabled" width="100">
        <template #default="{ row }">
          {{ row.disabled ? '是' : '否' }}
        </template>
      </el-table-column>
      <!-- 模型最大上下文长度：未设置 / null 显示占位符 -->
      <el-table-column label="Max Context" width="120">
        <template #default="{ row }">
          {{ row.max_context_length ?? '—' }}
        </template>
      </el-table-column>
      <el-table-column label="Actions" width="320" fixed="right">
        <template #default="{ row }">
          <!-- 连通性测试：调用后端测试接口，结果弹窗展示 -->
          <el-button size="small" :loading="testingId === row.id" @click="testUpstream(row as UpstreamItem)">测试</el-button>
          <el-button size="small" type="primary" @click="openEdit(row as UpstreamItem)">编辑</el-button>
          <!-- 暂停/恢复切换 -->
          <el-button size="small" :type="row.disabled ? 'success' : 'warning'" @click="togglePause(row as UpstreamItem)">
            {{ row.disabled ? '恢复' : '暂停' }}
          </el-button>
          <el-button size="small" type="danger" @click="removeUpstream(row as UpstreamItem)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增/编辑弹窗：同一表单，编辑模式禁用 id 且 apiKey 留空表示不修改 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId === null ? '新增上游' : '编辑上游'"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="ID" prop="id">
          <el-input v-model="form.id" placeholder="唯一标识，如 openai-main" :disabled="editingId !== null" />
        </el-form-item>
        <el-form-item label="Base URL" prop="baseUrl">
          <el-input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
        </el-form-item>
        <el-form-item label="API Key" prop="apiKey">
          <!-- 密码输入框：可切换明文/密文；编辑模式显示掩码值，留空表示保持原密钥 -->
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            :placeholder="editingId === null ? 'sk-...' : '留空则保持原密钥不变'"
          />
        </el-form-item>
        <el-form-item label="超时(ms)" prop="timeoutMs">
          <el-input-number v-model="form.timeoutMs" :min="1" :step="1000" />
        </el-form-item>
        <!-- 最大上下文：可手动输入或点「自动」调用后端探测（llama.cpp / LM Studio） -->
        <el-form-item label="最大上下文" prop="max_context_length">
          <div class="probe-row">
            <el-input-number
              v-model="form.max_context_length"
              :min="1"
              :step="1024"
              :value-on-clear="null"
              clearable
              placeholder="自动或手动填写（Max Context）"
            />
            <el-button :loading="probing" :disabled="!form.baseUrl" @click="probeMaxContext">自动</el-button>
          </div>
        </el-form-item>
        <el-form-item label="暂停" prop="disabled">
          <el-switch v-model="form.disabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { api } from '../api/client'

// 上游数据结构（apiKey 为后端掩码后的展示值，不落日志）
interface UpstreamItem {
  id: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  disabled: boolean
  // 模型最大上下文长度：null=显式清空，undefined=未设置，正整数=已配置
  max_context_length?: number | null
}

const loading = ref(false) // 列表加载中
const upstreams = ref<UpstreamItem[]>([]) // 上游列表
const testingId = ref('') // 正在测试的上游 id（用于按钮 loading）
const saving = ref(false) // 表单保存中
const probing = ref(false) // 探测 max_context_length 中（用于「自动」按钮 loading）
const dialogVisible = ref(false) // 弹窗开关
const editingId = ref<string | null>(null) // 当前编辑的上游 id，null 表示新增
const formRef = ref<FormInstance>()

// 表单数据：apiKey 编辑模式留空表示不修改；max_context_length null 表示显式清空
const form = reactive({
  id: '',
  baseUrl: '',
  apiKey: '',
  timeoutMs: 30000,
  disabled: false,
  max_context_length: null as number | null,
})

// 表单校验规则：编辑模式 id 不可改；apiKey 仅新增时必填
const rules = reactive<FormRules>({
  id: [{ required: true, message: '请输入 ID', trigger: 'blur' }],
  baseUrl: [
    { required: true, message: '请输入 Base URL', trigger: 'blur' },
    { type: 'url', message: '必须是合法 URL', trigger: 'blur' },
  ],
  apiKey: [
    {
      validator: (_rule, value: string, callback) => {
        if (editingId.value === null && !value) {
          callback(new Error('请输入 API Key'))
        } else {
          callback()
        }
      },
      trigger: 'blur',
    },
  ],
})

// 暂停的行：灰底样式（配合下方 .paused-row 样式）
const rowClassName = ({ row }: { row: UpstreamItem }) => (row.disabled ? 'paused-row' : '')

// 拉取上游列表（GET /upstreams）
async function fetchUpstreams() {
  loading.value = true
  try {
    const { data } = await api.get<UpstreamItem[]>('/upstreams')
    upstreams.value = data
  } catch (err: any) {
    ElMessage.error(`加载上游失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    loading.value = false
  }
}

// 打开新增弹窗：重置表单
function openCreate() {
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

// 打开编辑弹窗：预填已有数据（apiKey 为掩码值）
function openEdit(row: UpstreamItem) {
  editingId.value = row.id
  form.id = row.id
  form.baseUrl = row.baseUrl
  form.apiKey = row.apiKey
  form.timeoutMs = row.timeoutMs
  form.disabled = row.disabled
  // 已存储的 max_context_length：null/undefined 都按 null 渲染以便「清空」编辑
  form.max_context_length =
    typeof row.max_context_length === 'number' ? row.max_context_length : null
  dialogVisible.value = true
}

// 重置表单内容与校验状态
function resetForm() {
  form.id = ''
  form.baseUrl = ''
  form.apiKey = ''
  form.timeoutMs = 30000
  form.disabled = false
  form.max_context_length = null
  formRef.value?.clearValidate()
}

// 保存（新增 POST /upstreams；编辑 PUT /upstreams/:id，apiKey 留空则不下发）
async function save() {
  await formRef.value?.validate()
  saving.value = true
  try {
    if (editingId.value === null) {
      // 新增模式：max_context_length 非 null 才下发（null 视为未设置，避免无意义字段）
      const payload: Record<string, unknown> = {
        id: form.id,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        timeoutMs: form.timeoutMs,
        disabled: form.disabled,
      }
      if (form.max_context_length !== null) {
        payload.max_context_length = form.max_context_length
      }
      await api.post('/upstreams', payload)
      ElMessage.success('上游已新增')
    } else {
      // 编辑模式：apiKey 为空串表示保持原密钥，不发送（避免掩码值覆盖明文）；
      // max_context_length 始终下发（含 null），用于显式清空已存值
      const payload: Record<string, unknown> = {
        baseUrl: form.baseUrl,
        timeoutMs: form.timeoutMs,
        disabled: form.disabled,
        max_context_length: form.max_context_length,
      }
      if (form.apiKey !== '') {
        payload.apiKey = form.apiKey
      }
      await api.put(`/upstreams/${editingId.value}`, payload)
      ElMessage.success('上游已更新')
    }
    dialogVisible.value = false
    await fetchUpstreams()
  } catch (err: any) {
    ElMessage.error(`保存失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    saving.value = false
  }
}

// 自动探测 max_context_length：新增模式传 baseUrl+apiKey；编辑模式传 id+baseUrl 让后端用配置真实密钥
async function probeMaxContext() {
  if (!form.baseUrl) {
    ElMessage.error('请先填写 Base URL')
    return
  }
  probing.value = true
  try {
    const body: Record<string, unknown> = { baseUrl: form.baseUrl }
    if (editingId.value !== null) {
      body.id = editingId.value
    } else {
      body.apiKey = form.apiKey
    }
    const { data } = await api.post<{
      ok: boolean
      max_context_length?: number
      error?: string
    }>('/upstreams/probe-context', body)
    if (data.ok && typeof data.max_context_length === 'number') {
      form.max_context_length = data.max_context_length
      ElMessage.success(`已自动填充：${data.max_context_length}`)
    } else {
      ElMessage.error(`探测失败：${data.error ?? 'unknown'}`)
    }
  } catch (err: any) {
    ElMessage.error(`探测失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    probing.value = false
  }
}

// 连通性测试：POST /upstreams/:id/test，结果用弹窗展示（含延迟与状态码）
async function testUpstream(row: UpstreamItem) {
  testingId.value = row.id
  try {
    const { data } = await api.post<{
      ok: boolean
      status: number
      latencyMs: number
      modelCount: number
      error?: string
    }>(`/upstreams/${row.id}/test`)
    await ElMessageBox.alert(
      `<div>
        <p>状态：<b>${data.ok ? '成功' : '失败'}</b></p>
        <p>延迟：${data.latencyMs.toFixed(1)} ms</p>
        <p>HTTP：${data.status}</p>
        <p>模型数：${data.modelCount}</p>
        ${data.error ? `<p>错误码：${data.error}</p>` : ''}
      </div>`,
      `测试结果：${row.id}`,
      { dangerouslyUseHTMLString: true },
    )
  } catch (err: any) {
    ElMessage.error(`测试失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    testingId.value = ''
  }
}

// 暂停/恢复切换：PUT /upstreams/:id 仅下发 disabled 字段
async function togglePause(row: UpstreamItem) {
  try {
    await api.put(`/upstreams/${row.id}`, { disabled: !row.disabled })
    ElMessage.success(row.disabled ? '已恢复' : '已暂停')
    await fetchUpstreams()
  } catch (err: any) {
    ElMessage.error(`操作失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 删除：先确认再 DELETE /upstreams/:id
async function removeUpstream(row: UpstreamItem) {
  try {
    await ElMessageBox.confirm(`确认删除上游「${row.id}」？相关模型别名引用将被清理。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await api.delete(`/upstreams/${row.id}`)
    ElMessage.success('已删除')
    await fetchUpstreams()
  } catch (err: any) {
    // 用户取消时不提示
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(`删除失败：${err?.response?.data?.error ?? err.message}`)
  }
}

// 页面挂载后加载列表
onMounted(fetchUpstreams)
</script>

<style scoped>
.upstreams-page {
  padding: 16px;
}

.toolbar {
  margin-bottom: 16px;
}

/* 暂停行：灰色背景，与正常行区分但不隐藏 */
:deep(.paused-row) {
  background-color: #f0f0f0;
  color: #909399;
}

/* Max Context 输入 + 自动按钮水平排列 */
.probe-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

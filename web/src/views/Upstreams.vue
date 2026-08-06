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
        <el-form-item label="暂停" prop="disabled">
          <el-switch v-model="form.disabled" />
        </el-form-item>
        <el-form-item label="Responses API" prop="responsesApi">
          <!-- Responses API 处理策略：native=原生透传 / convert=转换为 chat（缺省 convert） -->
          <!-- 表单行内 flex 布局：select 占满剩余宽度，「检测」按钮调 detect-responses 两步判定并自动回填 -->
          <div class="responses-api-row">
            <el-select v-model="form.responsesApi" class="responses-api-select">
              <el-option label="native (原生透传)" value="native" />
              <el-option label="convert (转换为 chat)" value="convert" />
            </el-select>
            <el-button :loading="detecting" @click="detectResponses">检测</el-button>
          </div>
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
// `responsesApi` 决定 `/v1/responses` 的处理策略：'native' 原生透传、'convert' 转换为 chat（缺省 convert）
interface UpstreamItem {
  id: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  disabled: boolean
  responsesApi?: 'native' | 'convert'
}

const loading = ref(false) // 列表加载中
const upstreams = ref<UpstreamItem[]>([]) // 上游列表
const testingId = ref('') // 正在测试的上游 id（用于按钮 loading）
const saving = ref(false) // 表单保存中
const detecting = ref(false) // Responses API 检测中（按钮 loading）
const dialogVisible = ref(false) // 弹窗开关
const editingId = ref<string | null>(null) // 当前编辑的上游 id，null 表示新增
const formRef = ref<FormInstance>()
const DEFAULT_TIMEOUT_MS = 300000
// 表单数据：apiKey 编辑模式留空表示不修改；responsesApi 缺省 convert
const form = reactive({
  id: '',
  baseUrl: '',
  apiKey: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  disabled: false,
  responsesApi: 'convert' as 'native' | 'convert',
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
  form.responsesApi = row.responsesApi ?? 'convert'
  dialogVisible.value = true
}

// 重置表单内容与校验状态
function resetForm() {
  form.id = ''
  form.baseUrl = ''
  form.apiKey = ''
  form.timeoutMs = DEFAULT_TIMEOUT_MS
  form.disabled = false
  form.responsesApi = 'convert'
  formRef.value?.clearValidate()
}

// 保存（新增 POST /upstreams；编辑 PUT /upstreams/:id，apiKey 留空则不下发）
async function save() {
  await formRef.value?.validate()
  saving.value = true
  try {
    if (editingId.value === null) {
      const payload: Record<string, unknown> = {
        id: form.id,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        timeoutMs: form.timeoutMs,
        disabled: form.disabled,
        responsesApi: form.responsesApi,
      }
      await api.post('/upstreams', payload)
      ElMessage.success('上游已新增')
    } else {
      // 编辑模式：apiKey 为空串表示保持原密钥，不发送（避免掩码值覆盖明文）
      const payload: Record<string, unknown> = {
        baseUrl: form.baseUrl,
        timeoutMs: form.timeoutMs,
        disabled: form.disabled,
        responsesApi: form.responsesApi,
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

// Responses API 检测：POST /upstreams/:id/detect-responses（两步：① 非流式 ② 流式事件完整性）
// 编辑模式：path 用真实 id，body.baseUrl 触发覆盖模式（apiKey 缺省空 → 对鉴权上游需另填）
// 新增模式：上游尚未落配置，path 用占位 id 'detect'，body 必须含 baseUrl + apiKey 走覆盖分支
async function detectResponses() {
  // 触发前必填校验：baseUrl 必填；新增模式 apiKey 也必填（表单已有规则，此处兜底）
  if (!form.baseUrl) {
    ElMessage.error('请先填写 Base URL')
    return
  }
  if (editingId.value === null && !form.apiKey) {
    ElMessage.error('请先填写 API Key')
    return
  }
  detecting.value = true
  try {
    // body.baseUrl 存在即命中后端覆盖分支：跳过配置查找、新建临时 client
    const body: Record<string, unknown> = { baseUrl: form.baseUrl }
    // 新增模式必须带 apiKey（覆盖分支 apiKey 缺省空，上游鉴权会失败）
    if (editingId.value === null) {
      body.apiKey = form.apiKey
    }
    // 新增模式上游尚未创建，path id 任意占位即可（body.baseUrl 触发覆盖分支，id 完全不查）
    const idForPath = editingId.value ?? 'detect'
    const { data } = await api.post<{
      ok: boolean
      responsesApi?: 'native' | 'convert'
      error?: string
    }>(`/upstreams/${idForPath}/detect-responses`, body)
    if (!data.ok || !data.responsesApi) {
      ElMessage.error(`检测失败：${data.error ?? '未知错误'}`)
      return
    }
    // 成功：自动回填下拉 + 提示
    form.responsesApi = data.responsesApi
    ElMessage.success(`检测结果：${data.responsesApi}`)
  } catch (err: any) {
    ElMessage.error(`检测失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    detecting.value = false
  }
}

// 连通性测试：POST /upstreams/:id/test，结果用弹窗展示（含延迟与状态码 + Responses 支持三态）
async function testUpstream(row: UpstreamItem) {
  testingId.value = row.id
  try {
    const { data } = await api.post<{
      ok: boolean
      status: number
      latencyMs: number
      modelCount: number
      error?: string
      // true=原生支持 / false=明确不支持 / null 或缺失=未知（探测异常或上游不可达）
      supportsResponses?: boolean | null
    }>(`/upstreams/${row.id}/test`)
    // 三态语义：true→是；false→否；其它（null/undefined）→未知
    const responsesLabel =
      data.supportsResponses === true ? '是' : data.supportsResponses === false ? '否' : '未知'
    await ElMessageBox.alert(
      `<div>
        <p>状态：<b>${data.ok ? '成功' : '失败'}</b></p>
        <p>延迟：${data.latencyMs.toFixed(1)} ms</p>
        <p>HTTP：${data.status}</p>
        <p>模型数：${data.modelCount}</p>
        <p>Responses API 支持：<b>${responsesLabel}</b></p>
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

/* Responses API 行：select 占满剩余宽度 + 「检测」按钮固定宽度 */
.responses-api-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.responses-api-select {
  flex: 1;
  min-width: 0;
}
</style>

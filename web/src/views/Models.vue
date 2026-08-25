<template>
  <div class="models-page">
    <!-- 顶部操作区：新增别名 -->
    <div class="page-header">
      <h2>下游模型别名</h2>
      <el-space>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        <el-button type="primary" :icon="Plus" @click="addAlias">新增别名</el-button>        
      </el-space>
    </div>

    <div v-loading="loading" class="models-body">
      <!-- 无别名时的空状态 -->
      <el-empty v-if="!loading && Object.keys(models).length === 0" description="暂无下游模型别名，点击右上角「新增别名」创建" />

      <template v-else>
        <!-- 每个别名一个折叠面板 -->
        <el-collapse v-model="activeNames" expand-icon-position="left">
          <el-collapse-item v-for="alias in Object.keys(models)" :key="alias" :name="alias">
            <template #title>
              <div class="alias-title-container">
                <CopyText class="alias-title" :copy-text="alias">{{ alias }}</CopyText>
                <div class="alias-actions">
                  <el-button size="small" type="primary" :icon="Plus" @click="addCandidate(alias)" title="新增候选" circle/>
                  <el-button size="small" type="danger" :icon="Delete" @click="removeAlias(alias)" title="删除别名" circle />                
                </div>
              </div>
            </template>

            <!-- 候选列表：拖拽手柄排序，vuedraggable 的 :list 会在拖拽结束时原地重排 -->
            <draggable
              :list="models[alias].candidates"
              :item-key="itemKey"
              handle=".drag-handle"
              animation="150"
            >
              <template #item="{ element, index }">
                <div class="candidate-row">
                  <el-icon class="drag-handle"><Rank /></el-icon>
                  <el-select
                    v-model="element.upstreamId"
                    class="upstream-select"
                    placeholder="选择上游"
                    filterable
                  >
                    <el-option v-for="u in upstreams" :key="u.id" :label="u.id" :value="u.id" />
                  </el-select>
                  <el-input v-model="element.model" placeholder="上游侧模型名" />
                  <el-input-number
                    v-model="element.max_context_length"
                    class="nctx-input"
                    :min="1"
                    :step="1024"
                    :value-on-clear="null"
                    clearable
                    placeholder="Max Context"
                  />
                  <el-select
                    v-model="element.capabilities"
                    class="caps-select"
                    multiple
                    collapse-tags
                    collapse-tags-tooltip
                    filterable
                    allow-create
                    default-first-option
                    clearable
                    placeholder="能力"
                  >
                    <el-option v-for="cap in CAPABILITY_OPTIONS" :key="cap" :label="cap" :value="cap" />
                  </el-select>
                  <el-button
                    size="small"
                    :loading="probingKey === element._key"
                    :disabled="!element.upstreamId || !element.model"
                    @click="probeCandidate(element)"
                  >
                    自动
                  </el-button>
                  <el-button :icon="Delete" text type="danger" @click="removeCandidate(alias, index)" />
                </div>
              </template>
            </draggable>

            <!-- 别名内操作：新增候选 / 删除别名 -->
            <div class="alias-actions">
              
            </div>
          </el-collapse-item>
        </el-collapse>

        <!-- 底部保存：显式提交，不随编辑自动保存 -->
        <div class="page-footer">
          
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, Rank } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'
import CopyText from '../components/CopyText.vue'
import { api } from '../api/client'

// 别名组（"别名级总开关 + 候选列表"模型）：
// - disabled：别名级总开关（true → 整个别名对外不可见）
// - candidates：候选列表（候选级粒度不再有开关：要禁用就关上游，或直接删除候选）
interface AliasGroup {
  disabled: boolean
  candidates: Candidate[]
}

// 候选条目：上游 id + 上游侧模型名 + 最大上下文；_key 仅用于拖拽排序的稳定 Vue key，保存时剔除
interface Candidate {
  _key: number
  upstreamId: string
  model: string
  max_context_length?: number | null
  capabilities?: string[]
}

// 上游信息（管理端接口返回的 apiKey 已脱敏）
interface Upstream {
  id: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  disabled: boolean
}

// 别名 → AliasGroup（"总开关 + 候选列表"两层结构）
type DownstreamModels = Record<string, AliasGroup>

// Ollama 风格能力选项
const CAPABILITY_OPTIONS = ['completion', 'tools', 'vision', 'thinking', 'embedding', 'insert', 'audio']

// 服务端读取时的后端裸形态：宽松装载，再归一化为 AliasGroup；候选级无 disabled 字段
type RawAliasEntry =
  | { disabled?: boolean; candidates: Array<Omit<Candidate, '_key'>> }
  | Array<Omit<Candidate, '_key'>>

// 候选自增序号：为每个候选生成稳定且唯一的 key
let seq = 0

const upstreams = ref<Upstream[]>([])
const models = reactive<DownstreamModels>({})
const loading = ref(false)
const saving = ref(false)
const probingKey = ref<number | null>(null) // 正在探测的候选 _key（用于按钮 loading）
const activeNames = ref<string[]>([])

// vuedraggable itemKey：候选对象自带稳定 _key
const itemKey = (c: Candidate) => c._key

// 拉取上游列表 + 现有下游模型映射
async function load() {
  loading.value = true
  try {
    const [upRes, modelRes] = await Promise.all([
      api.get('/upstreams'),
      api.get('/downstream-models'),
    ])
    upstreams.value = upRes.data as Upstream[]
    // 整体替换 reactive 映射内容（Object.assign 无法覆盖已删除的旧键）
    for (const k of Object.keys(models)) delete models[k]
    for (const [alias, rawEntry] of Object.entries(modelRes.data as Record<string, RawAliasEntry>)) {
      models[alias] = normalizeAliasGroup(rawEntry)
    }
    // 默认展开全部别名
    activeNames.value = Object.keys(models)
  } catch (err) {
    ElMessage.error(`加载失败：${errMsg(err)}`)
  } finally {
    loading.value = false
  }
}

// 把后端拿到的 entry（旧裸数组 / 新 group）统一归一化为 AliasGroup，
// 缺失字段都用 false / [] 兜底，保持前端状态结构稳定
function normalizeAliasGroup(raw: RawAliasEntry): AliasGroup {
  if (Array.isArray(raw)) {
    return {
      disabled: false,
      candidates: raw.map((c) => buildCandidate(c)),
    }
  }
  return {
    disabled: raw.disabled === true,
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.map((c) => buildCandidate(c))
      : [],
  }
}

function buildCandidate(raw: Omit<Candidate, '_key'>): Candidate {
  return {
    _key: ++seq,
    upstreamId: raw.upstreamId,
    model: raw.model,
    max_context_length: raw.max_context_length ?? null,
    capabilities: raw.capabilities ?? [],
  }
}

// 新增别名：输入名称，校验非空且不重复
async function addAlias() {
  try {
    const { value } = await ElMessageBox.prompt('请输入模型别名（如 gpt-4）', '新增别名', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValidator: (v: string) => {
        const name = v.trim()
        if (!name) return '别名不能为空'
        if (name in models) return '别名已存在'
        return true
      },
    })
    const name = value.trim()
    models[name] = { disabled: false, candidates: [] }
    activeNames.value.push(name)
  } catch {
    // 用户取消输入，忽略
  }
}

// 删除别名
function removeAlias(alias: string) {
  delete models[alias]
  activeNames.value = activeNames.value.filter((n) => n !== alias)
}

// 新增候选：默认选中第一个上游，名称留空待填
function addCandidate(alias: string) {
  models[alias].candidates.push({
    _key: ++seq,
    upstreamId: upstreams.value[0]?.id ?? '',
    model: '',
    max_context_length: null,
    capabilities: [],
  })
}

// 删除候选
function removeCandidate(alias: string, index: number) {
  models[alias].candidates.splice(index, 1)
}

// 保存：整体替换下游模型映射（PUT），前端先校验再提交
async function save() {
  const entries = Object.entries(models)
  if (entries.length === 0) {
    ElMessage.warning('请先新增至少一个模型别名')
    return
  }
  for (const [alias, group] of entries) {
    if (group.candidates.length === 0) {
      ElMessage.warning(`别名「${alias}」没有候选上游，请添加候选或删除该别名`)
      return
    }
    for (const c of group.candidates) {
      if (!c.upstreamId || c.model.trim() === '') {
        ElMessage.warning(`别名「${alias}」存在未填写完整（上游/模型名）的候选`)
        return
      }
    }
  }
  saving.value = true
  try {
    // payload 形态对齐后端 group 形态：{ disabled, candidates: [...] }，
    // 字段剔除：_key（仅前端用）、max_context_length 为 null 时剔除、capabilities 空数组剔除
    const payload: Record<string, { disabled: boolean; candidates: Array<Record<string, unknown>> }> = {}
    for (const [alias, group] of entries) {
      payload[alias] = {
        disabled: group.disabled,
        candidates: group.candidates.map((c) => {
          const row: Record<string, unknown> = { upstreamId: c.upstreamId, model: c.model }
          if (typeof c.max_context_length === 'number') {
            row.max_context_length = c.max_context_length
          }
          if (c.capabilities && c.capabilities.length > 0) {
            row.capabilities = c.capabilities
          }
          return row
        }),
      }
    }
    await api.put('/downstream-models', payload)
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(`保存失败：${errMsg(err)}`)
  } finally {
    saving.value = false
  }
}

// 读取别名总开关状态（后端 Router 的判定口径）
function getAliasDisabled(alias: string): boolean {
  return models[alias]?.disabled === true
}

// 切换别名总开关：仅翻转 group.disabled
function toggleAlias(alias: string) {
  const group = models[alias]
  if (!group) return
  group.disabled = !group.disabled
}

// 自动探测候选的 max_context_length：调 POST /candidates/probe-context（upstreamId + model）
async function probeCandidate(candidate: Candidate) {
  if (!candidate.upstreamId || !candidate.model.trim()) {
    ElMessage.error('请先填写上游与模型名')
    return
  }
  probingKey.value = candidate._key
  try {
    const { data } = await api.post<{
      ok: boolean
      max_context_length?: number
      error?: string
    }>('/candidates/probe-context', {
      upstreamId: candidate.upstreamId,
      model: candidate.model.trim(),
    })
    if (data.ok && typeof data.max_context_length === 'number') {
      candidate.max_context_length = data.max_context_length
      ElMessage.success(`已自动填充：${data.max_context_length}`)
    } else {
      ElMessage.error(`探测失败：${data.error ?? 'unknown'}`)
    }
  } catch (err: any) {
    ElMessage.error(`探测失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    probingKey.value = null
  }
}

// 提取错误信息：优先展示后端返回的 error/issues
function errMsg(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; issues?: string[] } } }).response?.data
  if (data?.issues?.length) return data.issues.join('；')
  if (data?.error) return data.error
  return err instanceof Error ? err.message : String(err)
}

onMounted(load)
</script>

<style scoped>
.models-page {
  padding: 4px 8px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-header h2 {
  margin: 0;
  font-size: 18px;
}



/* 别名级开关：贴在折叠面板标题右侧；点击不冒泡到折叠触发 */
.alias-switch {
  margin: 0 8px;
}

.alias-disabled-tag {
  margin-left: 4px;
}

.alias-title-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  .alias-title {
    font-weight: 600;
  }

  .alias-actions {
    display: flex;
    gap: 8px;
  }
}

/* 候选列表行：拖拽手柄 + 上游选择 + 模型名 + 删除 */
.candidate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.candidate-row .upstream-select {
  width: 200px;
  flex-shrink: 0;
}

.candidate-row .el-input {
  flex: 1;
  min-width: 120px;
}

.candidate-row .nctx-input {
  width: 160px;
  flex-shrink: 0;
}

.candidate-row .caps-select {
  width: 220px;
  flex-shrink: 0;
}

.drag-handle {
  cursor: grab;
  color: var(--el-text-color-secondary);
}

.drag-handle:active {
  cursor: grabbing;
}

.alias-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.page-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>

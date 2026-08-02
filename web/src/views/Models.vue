<template>
  <div class="models-page">
    <!-- 顶部操作区：新增别名 -->
    <div class="page-header">
      <h2>下游模型别名</h2>
      <el-button type="primary" :icon="Plus" @click="addAlias">新增别名</el-button>
    </div>

    <div v-loading="loading" class="models-body">
      <!-- 无别名时的空状态 -->
      <el-empty v-if="!loading && Object.keys(models).length === 0" description="暂无下游模型别名，点击右上角「新增别名」创建" />

      <template v-else>
        <!-- 每个别名一个折叠面板 -->
        <el-collapse v-model="activeNames">
          <el-collapse-item v-for="alias in Object.keys(models)" :key="alias" :name="alias">
            <template #title>
              <span class="alias-title">{{ alias }}</span>
            </template>

            <!-- 候选列表：拖拽手柄排序，vuedraggable 的 :list 会在拖拽结束时原地重排 -->
            <draggable
              class="candidate-list"
              :list="models[alias]"
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
                  <el-button :icon="Delete" text type="danger" @click="removeCandidate(alias, index)" />
                </div>
              </template>
            </draggable>

            <!-- 别名内操作：新增候选 / 删除别名 -->
            <div class="alias-actions">
              <el-button size="small" :icon="Plus" @click="addCandidate(alias)">新增候选</el-button>
              <el-button size="small" text type="danger" @click="removeAlias(alias)">删除别名</el-button>
            </div>
          </el-collapse-item>
        </el-collapse>

        <!-- 底部保存：显式提交，不随编辑自动保存 -->
        <div class="page-footer">
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
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
import { api } from '../api/client'

// 候选条目：上游 id + 上游侧模型名；_key 仅用于拖拽排序的稳定 Vue key，保存时剔除
interface Candidate {
  _key: number
  upstreamId: string
  model: string
}

// 上游信息（管理端接口返回的 apiKey 已脱敏）
interface Upstream {
  id: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  disabled: boolean
}

// 别名 → 有序候选列表（按顺序尝试、失败切换下一个）
type DownstreamModels = Record<string, Candidate[]>

// 候选自增序号：为每个候选生成稳定且唯一的 key
let seq = 0

const upstreams = ref<Upstream[]>([])
const models = reactive<DownstreamModels>({})
const loading = ref(false)
const saving = ref(false)
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
    for (const [alias, candidates] of Object.entries(modelRes.data as Record<string, Omit<Candidate, '_key'>[]>)) {
      models[alias] = candidates.map((c) => ({ _key: ++seq, ...c }))
    }
    // 默认展开全部别名
    activeNames.value = Object.keys(models)
  } catch (err) {
    ElMessage.error(`加载失败：${errMsg(err)}`)
  } finally {
    loading.value = false
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
    models[name] = []
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
  models[alias].push({ _key: ++seq, upstreamId: upstreams.value[0]?.id ?? '', model: '' })
}

// 删除候选
function removeCandidate(alias: string, index: number) {
  models[alias].splice(index, 1)
}

// 保存：整体替换下游模型映射（PUT），前端先校验再提交
async function save() {
  const entries = Object.entries(models)
  if (entries.length === 0) {
    ElMessage.warning('请先新增至少一个模型别名')
    return
  }
  for (const [alias, candidates] of entries) {
    if (candidates.length === 0) {
      ElMessage.warning(`别名「${alias}」没有候选上游，请添加候选或删除该别名`)
      return
    }
    for (const c of candidates) {
      if (!c.upstreamId || c.model.trim() === '') {
        ElMessage.warning(`别名「${alias}」存在未填写完整（上游/模型名）的候选`)
        return
      }
    }
  }
  saving.value = true
  try {
    // 剔除 _key 后提交，后端 zod 校验每个别名至少 1 个候选
    const payload: Record<string, { upstreamId: string; model: string }[]> = {}
    for (const [alias, candidates] of entries) {
      payload[alias] = candidates.map(({ upstreamId, model }) => ({ upstreamId, model }))
    }
    await api.put('/downstream-models', payload)
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(`保存失败：${errMsg(err)}`)
  } finally {
    saving.value = false
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

.alias-title {
  font-weight: 600;
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

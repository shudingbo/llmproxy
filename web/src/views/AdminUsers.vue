<template>
  <div class="admin-users-page">
    <!-- 顶部工具栏：新建 + 刷新 -->
    <div class="toolbar">
      <el-button type="primary" :icon="Plus" @click="openCreate">新建管理员</el-button>
      <el-button :icon="Refresh" :loading="loading" @click="fetchAdmins">刷新</el-button>
    </div>

    <!-- 管理员账号列表 -->
    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="username" label="用户名" min-width="140" />
      <el-table-column label="禁用" width="120">
        <template #default="{ row }">
          <!-- 开关直接切换 disabled；改完立即 PATCH，失败回滚 -->
          <el-switch
            v-model="row.disabled"
            inline-prompt
            active-text="禁用"
            inactive-text="启用"
            @change="(val: string | number | boolean) => toggleDisabled(row as AdminAccount, val as boolean)"
          />
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="180">
        <template #default="{ row }">{{ formatTime((row as AdminAccount).createdAt) }}</template>
      </el-table-column>
      <el-table-column label="最后登录" min-width="180">
        <template #default="{ row }">{{ formatTime((row as AdminAccount).lastLoginAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="280" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openReset(row as AdminAccount)">重置密码</el-button>
          <el-button
            size="small"
            :type="(row as AdminAccount).disabled ? 'success' : 'warning'"
            @click="toggleDisabled(row as AdminAccount, !(row as AdminAccount).disabled)"
          >
            {{ (row as AdminAccount).disabled ? '启用' : '停用' }}
          </el-button>
          <!-- 不能删除自己（隐藏）；不能删除最后一个启用中账号（禁用 + 提示） -->
          <el-button
            v-if="!isSelf(row as AdminAccount)"
            size="small"
            type="danger"
            :disabled="isLastEnabled(row as AdminAccount)"
            :title="isLastEnabled(row as AdminAccount) ? '不能删除最后一个启用中的管理员' : ''"
            @click="removeAdmin(row as AdminAccount)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && rows.length === 0" description="暂无管理员账号" />

    <!-- 新建管理员弹窗：username / password 必填 + disabled -->
    <el-dialog
      v-model="createVisible"
      title="新建管理员"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetCreateForm"
    >
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="100px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="createForm.username" placeholder="登录用户名（唯一）" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="createForm.password" type="password" show-password placeholder="初始密码" />
        </el-form-item>
        <el-form-item label="停用" prop="disabled">
          <el-switch v-model="createForm.disabled" active-text="创建后即为停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码弹窗：单一 newPassword 字段 -->
    <el-dialog
      v-model="resetVisible"
      :title="`重置密码：${resetUsername}`"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetResetForm"
    >
      <el-form ref="resetFormRef" :model="resetForm" :rules="resetRules" label-width="100px">
        <el-form-item label="新密码" prop="password">
          <el-input v-model="resetForm.password" type="password" show-password placeholder="输入新密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetVisible = false">取消</el-button>
        <el-button type="primary" :loading="resetting" @click="submitReset">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { api } from '../api/client'
import { useAuthStore } from '../stores/auth'

// 管理员账号（后端不回显密码，hasPassword 仅表是否已设）
interface AdminAccount {
  username: string
  disabled: boolean
  createdAt: string
  lastLoginAt: string | null
  hasPassword: boolean
}

const auth = useAuthStore()
const loading = ref(false)
const rows = ref<AdminAccount[]>([])

// 新建
const createVisible = ref(false)
const creating = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive({ username: '', password: '', disabled: false })
const createRules = reactive<FormRules>({
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
})

// 重置密码
const resetVisible = ref(false)
const resetting = ref(false)
const resetUsername = ref('')
const resetFormRef = ref<FormInstance>()
const resetForm = reactive({ password: '' })
const resetRules = reactive<FormRules>({
  password: [{ required: true, message: '请输入新密码', trigger: 'blur' }],
})

// 当前登录用户名（用于「不能删除自己」判定）
const currentUsername = computed(() => auth.user?.username ?? '')

// 是否当前用户本人
function isSelf(row: AdminAccount): boolean {
  return row.username === currentUsername.value
}

// 是否为「唯一的启用中账号」（删除它将导致无人可登录）
function isLastEnabled(row: AdminAccount): boolean {
  if (row.disabled) return false
  const enabled = rows.value.filter((r) => !r.disabled)
  return enabled.length === 1 && enabled[0].username === row.username
}

// 时间格式化：空值显示占位符，非法值原样返回
function formatTime(v: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('zh-CN', { hour12: false })
}

// 拉取管理员列表（GET /admins，需登录态）
// 后端直接返回数组（与 POST/PATCH/DELETE 一致，未做 { rows } 包装）
async function fetchAdmins(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get<AdminAccount[]>('/admins')
    rows.value = Array.isArray(data) ? data : []
  } catch (err: unknown) {
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    ElMessage.error(`加载管理员列表失败：${e.response?.data?.msg ?? e.response?.data?.error ?? e.message}`)
  } finally {
    loading.value = false
  }
}

// 切换启用/停用：PATCH /admins/:username 仅下发 disabled
async function toggleDisabled(row: AdminAccount, disabled: boolean): Promise<void> {
  try {
    await api.patch(`/admins/${encodeURIComponent(row.username)}`, { disabled })
    ElMessage.success(disabled ? '已停用' : '已启用')
    await fetchAdmins()
  } catch (err: unknown) {
    // 失败回滚开关显示
    row.disabled = !disabled
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    ElMessage.error(`操作失败：${e.response?.data?.msg ?? e.response?.data?.error ?? e.message}`)
  }
}

// 新建管理员
function openCreate(): void {
  createVisible.value = true
}

function resetCreateForm(): void {
  createForm.username = ''
  createForm.password = ''
  createForm.disabled = false
  createFormRef.value?.clearValidate()
}

async function submitCreate(): Promise<void> {
  try {
    await createFormRef.value?.validate()
  } catch {
    return
  }
  creating.value = true
  try {
    await api.post('/admins', {
      username: createForm.username,
      password: createForm.password,
      disabled: createForm.disabled,
    })
    ElMessage.success('管理员已创建')
    createVisible.value = false
    await fetchAdmins()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    ElMessage.error(`创建失败：${e.response?.data?.msg ?? e.response?.data?.error ?? e.message}`)
  } finally {
    creating.value = false
  }
}

// 重置密码
function openReset(row: AdminAccount): void {
  resetUsername.value = row.username
  resetForm.password = ''
  resetVisible.value = true
}

function resetResetForm(): void {
  resetUsername.value = ''
  resetForm.password = ''
  resetFormRef.value?.clearValidate()
}

async function submitReset(): Promise<void> {
  try {
    await resetFormRef.value?.validate()
  } catch {
    return
  }
  resetting.value = true
  try {
    await api.patch(`/admins/${encodeURIComponent(resetUsername.value)}`, { password: resetForm.password })
    ElMessage.success('密码已重置')
    resetVisible.value = false
    await fetchAdmins()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    ElMessage.error(`重置失败：${e.response?.data?.msg ?? e.response?.data?.error ?? e.message}`)
  } finally {
    resetting.value = false
  }
}

// 删除：二次确认后 DELETE /admins/:username
async function removeAdmin(row: AdminAccount): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除管理员「${row.username}」？该账号将无法再登录管理后台。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await api.delete(`/admins/${encodeURIComponent(row.username)}`)
    ElMessage.success('已删除')
    await fetchAdmins()
  } catch (err: unknown) {
    // 用户取消确认不提示
    if (err === 'cancel' || err === 'close') return
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    ElMessage.error(`删除失败：${e.response?.data?.msg ?? e.response?.data?.error ?? e.message}`)
  }
}

onMounted(fetchAdmins)
</script>

<style scoped>
.admin-users-page {
  padding: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
</style>

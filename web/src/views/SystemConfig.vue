<template>
  <div class="system-config-page">
    <!-- 顶部操作区：标题 + 保存按钮 -->
    <div class="page-header">
      <h2>System Config</h2>
      <el-button type="primary" :loading="saving" :disabled="loading" @click="save">保存</el-button>
    </div>

    <!-- 配置热重载错误：最近一次文件监听重载失败时展示（当前运行的是旧配置） -->
    <el-alert
      v-if="reloadError"
      class="reload-error-alert"
      type="warning"
      :closable="false"
      show-icon
      :title="`配置热重载失败，当前运行的仍是旧配置：${reloadError}`"
    />

    <div v-loading="loading" class="config-body">
      <!-- 三节配置用 el-tabs 组织；tab-pane 默认立即渲染（非 lazy），三个表单 ref 始终可用 -->
      <el-tabs class="config-tabs">
        <!-- Server 进程级配置：socket 与 bodyLimit 启动时读取，改后必须重启 -->
        <el-tab-pane label="Server 进程配置">
          <el-text class="pane-note" type="warning" size="small">修改后需手动重启服务才生效</el-text>
          <el-form ref="serverFormRef" :model="form" :rules="rules" label-width="140px">
            <el-form-item label="监听地址" prop="server.host">
              <el-input v-model="form.server.host" placeholder="0.0.0.0" />
            </el-form-item>
            <el-form-item label="端口" prop="server.port">
              <el-input-number v-model="form.server.port" :min="1" :max="65535" :step="1" />
            </el-form-item>
            <el-form-item label="请求体上限" prop="server.bodyLimit">
              <el-input v-model="form.server.bodyLimit" placeholder="10mb" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- Auth 鉴权配置：enabled 每请求读取，保存后实时生效 -->
        <el-tab-pane label="Auth 鉴权配置">
          <el-text class="pane-note" type="success" size="small">保存后实时生效</el-text>
          <el-form ref="authFormRef" :model="form" :rules="rules" label-width="140px">
            <el-form-item label="鉴权开关" prop="auth.enabled">
              <el-switch v-model="form.auth.enabled" />
            </el-form-item>
            <el-form-item label="Key 长度" prop="auth.keyBytes">
              <el-input-number v-model="form.auth.keyBytes" :min="8" :max="64" :step="1" />
            </el-form-item>
            <el-form-item label="过期 Key 保留" prop="auth.cleanupRetentionDays">
              <el-input-number v-model="form.auth.cleanupRetentionDays" :min="0" :max="3650" :step="1" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- Routing 路由配置：会话亲和开关与清理参数启动时读取，改后需重启 -->
        <el-tab-pane label="Routing 路由配置">
          <el-text class="pane-note" type="warning" size="small">会话亲和开关与清理参数修改后需重启生效</el-text>
          <el-form ref="routingFormRef" :model="form" :rules="rules" label-width="140px">
            <el-form-item label="会话亲和" prop="routing.sessionAffinity.enabled">
              <el-switch v-model="form.routing.sessionAffinity.enabled" />
            </el-form-item>
            <el-form-item label="会话保留期 (ms)" prop="routing.sessionAffinity.cleanupMaxAgeMs">
              <el-input-number v-model="form.routing.sessionAffinity.cleanupMaxAgeMs" :min="0" :step="60000" />
            </el-form-item>
            <el-form-item label="自动清理周期 (ms)" prop="routing.sessionAffinity.cleanupIntervalMs">
              <el-input-number v-model="form.routing.sessionAffinity.cleanupIntervalMs" :min="0" :step="60000" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { api } from '../api/client'

// 表单结构：与 llmproxy.jsonc 的 server / auth / routing 三节一一对应
interface SystemConfigForm {
  server: { host: string; port: number; bodyLimit: string }
  auth: { enabled: boolean; keyBytes: number; cleanupRetentionDays: number }
  routing: {
    sessionAffinity: { enabled: boolean; cleanupMaxAgeMs: number; cleanupIntervalMs: number }
  }
}

// 后端返回的配置三节：字段均可缺省（缺省=后端按 schema 默认值处理）
interface ConfigSections {
  server?: { host?: string; port?: number; bodyLimit?: string | number }
  auth?: { enabled?: boolean; keyBytes?: number; cleanupRetentionDays?: number }
  routing?: {
    sessionAffinity?: { enabled?: boolean; cleanupMaxAgeMs?: number; cleanupIntervalMs?: number }
  }
}

// GET /admin/api/config 响应：新契约 { status, msg, config }；兼容旧版裸 config 形态
interface ConfigResponse {
  status?: boolean
  msg?: string
  config?: ConfigSections
  server?: ConfigSections['server']
  routing?: ConfigSections['routing']
  auth?: ConfigSections['auth']
}

// PUT /admin/api/config 响应：restartRequired 列出本次修改中需重启的顶层节
interface ConfigSaveResponse {
  status: boolean
  msg?: string
  config?: ConfigSections
  restartRequired?: string[]
}

// 表单缺省值：与后端 schema 默认值对齐（首次加载失败时表单仍可用）
const DEFAULT_FORM: SystemConfigForm = {
  server: { host: '127.0.0.1', port: 3000, bodyLimit: '10mb' },
  auth: { enabled: false, keyBytes: 24, cleanupRetentionDays: 7 },
  routing: { sessionAffinity: { enabled: true, cleanupMaxAgeMs: 604800000, cleanupIntervalMs: 3600000 } },
}

// 深拷贝（表单为纯 JSON 数据，JSON 序列化即可）
function cloneForm(src: SystemConfigForm): SystemConfigForm {
  return JSON.parse(JSON.stringify(src))
}

const loading = ref(false) // 配置加载中
const saving = ref(false) // 保存中
const reloadError = ref<string | null>(null) // 最近一次配置热重载错误（无则 null）
const serverFormRef = ref<FormInstance>()
const authFormRef = ref<FormInstance>()
const routingFormRef = ref<FormInstance>()
const form = reactive<SystemConfigForm>(cloneForm(DEFAULT_FORM))
// 加载时的配置快照：保存时与当前表单比较，判定哪些节实际有变更
const snapshot = ref<SystemConfigForm>(cloneForm(DEFAULT_FORM))

// 整数区间校验规则工厂：嵌套 rules 下自定义 validator 会丢失上下文类型，参数需显式标注
function intRangeRule(min: number, max: number | undefined, message: string) {
  return {
    validator: (_rule: unknown, value: unknown, callback: (error?: string | Error) => void) => {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < min ||
        (max !== undefined && value > max)
      ) {
        callback(new Error(message))
        return
      }
      callback()
    },
    trigger: 'change' as const,
  }
}

// 表单校验规则：嵌套结构对应嵌套 prop 路径（element-plus 按 'a.b.c' 逐层查找）
const rules = reactive<FormRules>({
  server: {
    host: [{ required: true, message: '请输入监听地址', trigger: 'blur' }],
    port: [
      { required: true, message: '请输入端口', trigger: 'blur' },
      intRangeRule(1, 65535, '端口必须是 1-65535 的整数'),
    ],
    bodyLimit: [{ required: true, message: '请输入请求体上限（如 10mb）', trigger: 'blur' }],
  },
  auth: {
    keyBytes: [
      { required: true, message: '请输入 Key 长度', trigger: 'blur' },
      intRangeRule(8, 64, 'keyBytes 必须是 8-64 的整数'),
    ],
    cleanupRetentionDays: [
      { required: true, message: '请输入保留天数', trigger: 'blur' },
      intRangeRule(0, 3650, '保留天数必须是 0-3650 的整数'),
    ],
  },
  routing: {
    sessionAffinity: {
      cleanupMaxAgeMs: [intRangeRule(0, undefined, '会话保留期必须是 >= 0 的整数（0 = 永不过期）')],
      cleanupIntervalMs: [intRangeRule(0, undefined, '自动清理周期必须是 >= 0 的整数（0 = 关闭自动清理）')],
    },
  },
})

// 把后端配置三节归一化填入表单；缺失的节保留当前值（首次即 schema 缺省）
function applyConfig(cfg?: ConfigSections) {
  if (!cfg) return
  if (cfg.server) {
    form.server.host = cfg.server.host ?? form.server.host
    form.server.port = cfg.server.port ?? form.server.port
    form.server.bodyLimit = String(cfg.server.bodyLimit ?? form.server.bodyLimit)
  }
  if (cfg.auth) {
    form.auth.enabled = cfg.auth.enabled ?? form.auth.enabled
    form.auth.keyBytes = cfg.auth.keyBytes ?? form.auth.keyBytes
    form.auth.cleanupRetentionDays = cfg.auth.cleanupRetentionDays ?? form.auth.cleanupRetentionDays
  }
  const sa = cfg.routing?.sessionAffinity
  if (sa) {
    form.routing.sessionAffinity.enabled = sa.enabled ?? form.routing.sessionAffinity.enabled
    form.routing.sessionAffinity.cleanupMaxAgeMs = sa.cleanupMaxAgeMs ?? form.routing.sessionAffinity.cleanupMaxAgeMs
    form.routing.sessionAffinity.cleanupIntervalMs =
      sa.cleanupIntervalMs ?? form.routing.sessionAffinity.cleanupIntervalMs
  }
}

// 拉取当前生效配置 + 最近重载错误（reload-error 为可选信息，失败不阻断主流程）
async function load() {
  loading.value = true
  try {
    const [cfgRes, errRes] = await Promise.all([
      api.get<ConfigResponse>('/config'),
      api.get<{ error: string | null }>('/config/reload-error').catch(() => null),
    ])
    // 兼容两种响应形态：新契约 { status, msg, config } 与旧版裸 config
    applyConfig(cfgRes.data?.config ?? cfgRes.data)
    snapshot.value = cloneForm(form)
    reloadError.value = errRes?.data?.error ?? null
  } catch (err: any) {
    ElMessage.error(`加载配置失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    loading.value = false
  }
}

// 校验三个分区表单；任一失败时 el-form 已就地展示错误，直接中止
async function validateAll(): Promise<boolean> {
  try {
    await Promise.all([
      serverFormRef.value?.validate(),
      authFormRef.value?.validate(),
      routingFormRef.value?.validate(),
    ])
    return true
  } catch {
    return false
  }
}

// 保存：全量提交三节（值以当前表单为准），按响应 restartRequired + 实际变更节提示
async function save() {
  if (!(await validateAll())) return
  saving.value = true
  try {
    // 与加载快照比较，判定实际发生变更的节（未变更的节不提示）
    const changed = {
      server: JSON.stringify(form.server) !== JSON.stringify(snapshot.value.server),
      auth: JSON.stringify(form.auth) !== JSON.stringify(snapshot.value.auth),
      routing: JSON.stringify(form.routing) !== JSON.stringify(snapshot.value.routing),
    }
    const { data } = await api.put<ConfigSaveResponse>('/config', {
      server: { ...form.server },
      auth: { ...form.auth },
      routing: { sessionAffinity: { ...form.routing.sessionAffinity } },
    })
    // 以服务端返回的最新配置刷新表单与快照（含 schema 默认值归一化结果）
    if (data?.config) {
      applyConfig(data.config)
      snapshot.value = cloneForm(form)
    }
    // 后端 restartRequired 以「请求体提供的节」为准，而本页面始终全量提交三节，
    // 故需与实际变更的节求交集，仅对真正改动的节提示
    const restartRequired: string[] = data?.restartRequired ?? []
    const serverNeedsRestart = restartRequired.includes('server') && changed.server
    const routingNeedsRestart = restartRequired.includes('routing') && changed.routing
    if (serverNeedsRestart) {
      ElMessage.warning('Server 配置已保存，需手动重启服务后才生效')
    }
    if (routingNeedsRestart) {
      ElMessage.warning('Routing 配置已保存，部分参数需重启服务后才生效')
    }
    if (!serverNeedsRestart && !routingNeedsRestart) {
      if (changed.auth) {
        ElMessage.success('Auth 配置已保存并实时生效')
      } else {
        ElMessage.success('配置已保存')
      }
    }
  } catch (err: any) {
    ElMessage.error(`保存失败：${err?.response?.data?.error ?? err.message}`)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.system-config-page {
  padding: 16px;
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

.reload-error-alert {
  margin-bottom: 16px;
}

/* 每个 tab 内 pane 顶部的生效方式标注：独占一行，与表单留出间距 */
.pane-note {
  display: block;
  margin-bottom: 16px;
}
</style>

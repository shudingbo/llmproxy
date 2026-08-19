<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-head">
        <div class="login-logo">LP</div>
        <h1 class="login-title">LLMProxy 登录</h1>
        <p class="login-sub">单端口 LLM 网关管理后台</p>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" @submit.prevent="submit">
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="用户名"
            :prefix-icon="User"
            clearable
            autocomplete="username"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            ref="passwordInputRef"
            v-model="form.password"
            type="password"
            placeholder="密码"
            :prefix-icon="Lock"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" class="login-btn" :loading="loading" @click="submit">
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Lock, User } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'
import { login } from '../api/auth'

// 登录表单：username / password
const form = reactive({
  username: '',
  password: '',
})

const rules = reactive<FormRules>({
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
})

// el-input 句柄：仅需 focus() 方法用于默认聚焦密码框
interface ElInputHandle {
  focus: () => void
}

const formRef = ref<FormInstance>()
const passwordInputRef = ref<ElInputHandle>()
const loading = ref(false)
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 默认焦点在密码框（用户名通常较短，直接输密码更快）
onMounted(() => {
  void nextTick(() => {
    passwordInputRef.value?.focus()
  })
})

// 登录成功回跳目标：优先 query.redirect，缺省 /dashboard
function targetPath(): string {
  const redirect = route.query.redirect
  const path = typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/dashboard'
  return path
}

// 提交登录：校验 → 计算 MD5 → 后端登录 → 记录登录态 → 回跳
async function submit(): Promise<void> {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  if (loading.value) return
  loading.value = true
  try {
    const username = await login(form.username, form.password)
    auth.setAuthenticated(username)
    router.push(targetPath())
  } catch (err: unknown) {
    // 失败统一提示（不区分「用户名错 / 密码错」，避免账号枚举）
    const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
    const msg = e.response?.data?.msg ?? e.response?.data?.error ?? e.message ?? '登录失败'
    ElMessage.error(msg)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 16px;
  background:
    radial-gradient(1200px 500px at 15% -10%, color-mix(in srgb, var(--el-color-primary) 14%, transparent), transparent 60%),
    radial-gradient(900px 420px at 110% 110%, color-mix(in srgb, var(--el-color-primary) 10%, transparent), transparent 55%),
    var(--el-bg-color-page);
}

.login-card {
  width: 400px;
  max-width: 90vw;
  padding: 32px 28px 20px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-light);
}

.login-head {
  margin-bottom: 24px;
  text-align: center;
}

.login-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-color-primary) 12%, var(--el-bg-color));
  color: var(--el-color-primary);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1px;
}

.login-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.login-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.login-btn {
  width: 100%;
}
</style>

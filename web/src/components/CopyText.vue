<template>
  <span class="copy-text">
    <el-text v-bind="textAttrs">
      <slot />
    </el-text>
    <el-button
      link
      size="small"
      :icon="CopyDocument"
      class="copy-text__btn"
      @click.stop="copy"
    />
  </span>
</template>

<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'

// 默认继承 class / style 到根 <span>（调用方传的 .alias-title 等仍生效），
// 其它属性（type / size / tag / truncated / line-clamp 等 el-text 支持的属性）转发给内部 el-text
defineOptions({ name: 'CopyText' })

const props = defineProps<{
  // 点击按钮实际复制的内容；为空时不复制并提示
  copyText?: string
}>()

const attrs = useAttrs()

// 从 attrs 中剥离 class / style，避免污染 el-text；copyText 是声明式 prop，不会出现在 attrs 里
const textAttrs = computed(() => {
  const result: Record<string, unknown> = {}
  for (const key in attrs) {
    if (key !== 'class' && key !== 'style') {
      result[key] = attrs[key]
    }
  }
  return result
})

async function copy(): Promise<void> {
  const text = props.copyText ?? ''
  if (!text) {
    ElMessage.warning('没有可复制的内容')
    return
  }
  // 优先走异步 Clipboard API；失败时回退到 execCommand（兼容非安全上下文）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      ElMessage.success('已复制到剪贴板')
      return
    }
    throw new Error('clipboard api unavailable')
  } catch {
    const ok = legacyCopy(text)
    if (ok) ElMessage.success('已复制到剪贴板')
    else ElMessage.error('复制失败，请手动复制')
  }
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
</script>

<style scoped>
.copy-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.copy-text__btn {
  padding: 0 4px;
  margin-left: 2px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  transition: color 0.15s ease;
}

.copy-text__btn:hover {
  color: var(--el-color-primary);
}
</style>
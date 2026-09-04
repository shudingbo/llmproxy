<!-- 会话探测抽屉：订阅 /admin/api/sessions/:sessionKey/messages（SSE），
     实时展示该会话与 LLM 交互的消息（历史回放 + 实时推送 + 流式增量渲染）。
     消息倒序（最新在上），每块显示类型标签（user/assistant/...）、内容（md 渲染）与时间；
     关闭抽屉即 abort fetch，服务端在连接断开时自动退订 -->
<template>
  <el-drawer
    v-model="drawerOpen"
    :title="drawerTitle"
    size="560px"
    :close-on-click-modal="false"
  >
    <div class="monitor-drawer">
      <!-- 状态栏：连接状态 / 消息总数 / 截断提示 -->
      <div class="monitor-head">
        <el-tag v-if="status === 'live'" type="success" size="small">监控中</el-tag>
        <el-tag v-else-if="status === 'connecting'" type="warning" size="small">连接中…</el-tag>
        <el-tag v-else type="info" size="small">已断开</el-tag>
        <span v-if="meta !== null" class="monitor-total">共 {{ meta.total }} 条</span>
        <span v-if="meta !== null && meta.truncated" class="monitor-truncated">
          （服务端仅回放最新 1000 条）
        </span>
        <span v-if="uiTruncated" class="monitor-truncated">（页面仅渲染最新 {{ MAX_RENDER }} 条）</span>
      </div>

      <el-alert v-if="error !== ''" :title="error" type="error" :closable="false" class="monitor-error" />

      <div v-if="displayed.length === 0 && error === ''" class="monitor-empty">
        <el-empty :image-size="60" description="暂无消息，该会话与 LLM 交互时将在此实时显示" />
      </div>

      <!-- 消息列表：倒序排列，最新的在最上面 -->
      <div v-else class="msg-list">
        <div
          v-for="m in displayed"
          :key="m.key"
          class="msg-block"
          :class="[`role-${roleClass(m.role)}`, { 'is-streaming': m.streaming }]"
        >
          <!-- 块头：消息类型标签（user / assistant / system / tool / 其它）+ 状态标记 -->
          <div class="msg-head">
            <el-tag :type="tagType(m.role)" size="small" effect="dark">{{ m.role }}</el-tag>
            <el-tag v-if="m.streaming" type="warning" size="small" effect="plain">生成中…</el-tag>
            <el-tag v-else-if="m.truncated" type="danger" size="small" effect="plain">已中断</el-tag>
            <span class="msg-key">#{{ m.key }}</span>
          </div>
          <!-- 内容：markdown-it 渲染（html 选项关闭，防 XSS）；流式期间随 delta 增量重渲染 -->
          <div class="md-body" v-html="renderMd(m.content)"></div>
          <!-- 块下方：时间（流式中为开始时间，结束后为完成时间） -->
          <div class="msg-time">{{ formatTime(m.at) }}</div>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { parseSseEvent } from '../api/chat'
import { fetchSessionMessages, type MonitorEvent } from '../api/session-monitor'

// 会话行（与 Sessions.vue 的 SessionRow 同形状，仅取展示与订阅所需字段）
export interface MonitorSessionRow {
  session_key: string
  session_id: string
  client: string
  downstream_model: string
  upstream_id: string
  upstream_model: string
}

// 消息块（UI 态）：key 唯一（历史消息 = 落库行 id；流式块 = 服务端临时 nonce）
interface MsgBlock {
  key: string
  role: string
  content: string
  at: number // 时间戳：流式块为首个 delta 时刻，完成后更新为完成时刻
  streaming: boolean
  truncated: boolean
}

// 页面渲染上限：防止超长会话撑爆 DOM（服务端回放本身默认上限 1000 条）
const MAX_RENDER = 500

const props = defineProps<{
  modelValue: boolean
  session: MonitorSessionRow | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

// el-drawer 的 v-model 桥接
const drawerOpen = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const messages = ref<MsgBlock[]>([])
const meta = ref<{ total: number; truncated: boolean } | null>(null)
const error = ref('')
const status = ref<'idle' | 'connecting' | 'live' | 'closed'>('idle')

// 渲染上限截断提示
const displayed = computed(() => messages.value.slice(0, MAX_RENDER))
const uiTruncated = computed(() => messages.value.length > MAX_RENDER)

const drawerTitle = computed(() => {
  const s = props.session
  if (s === null) return '探测'
  return `探测 · （${s.upstream_id} / ${s.upstream_model}）`
})

// markdown-it 实例：与 Chat 页同一配置（html 选项关闭防 XSS，linkify 自动链接、breaks 单换行转 <br>）
const md = new MarkdownIt({ linkify: true, breaks: true })

function renderMd(content: string): string {
  return md.render(content ?? '')
}

// 角色 → 块左侧色条样式类
function roleClass(role: string): string {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'tool':
      return 'tool'
    default:
      return 'other'
  }
}

// 角色 → el-tag 语义色
function tagType(role: string): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  switch (role) {
    case 'user':
      return 'primary'
    case 'assistant':
      return 'success'
    case 'system':
      return 'info'
    case 'tool':
      return 'warning'
    default:
      return 'info'
  }
}

// epoch ms → 本地时间字符串
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

// ===== SSE 消费 =====

let controller: AbortController | null = null

// 断开连接：abort fetch（服务端 res 'close' 时自动退订 + 停心跳）
function stop(): void {
  controller?.abort()
  controller = null
}

function reset(): void {
  messages.value = []
  meta.value = null
  error.value = ''
  status.value = 'connecting'
}

async function start(): Promise<void> {
  const session = props.session
  if (session === null) return
  stop()
  reset()
  controller = new AbortController()
  try {
    const stream = await fetchSessionMessages(session.session_key, controller.signal)
    status.value = 'live'
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    // 未消费尾部缓冲：只取到最后一个完整 \n\n 为止，残片留给下一块拼接
    // （parseSseEvent 是无状态解析器，契约见 chat.ts 注释）
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const sep = buffer.lastIndexOf('\n\n')
      if (sep === -1) continue
      const completePart = buffer.slice(0, sep + 2)
      buffer = buffer.slice(sep + 2)
      for (const ev of parseSseEvent(completePart)) {
        if ('done' in ev) continue // 监控端点不发 [DONE]，防御分支
        handleEvent(JSON.parse(ev.data) as MonitorEvent)
      }
    }
    // 服务端主动关闭（异常路径）→ 标记断开
    status.value = 'closed'
  } catch (err: unknown) {
    // 主动中止（关闭抽屉）不当错误
    if (controller?.signal.aborted) return
    status.value = 'closed'
    error.value = `监控连接失败：${err instanceof Error ? err.message : String(err)}`
  }
}

// 倒序插入：新块置顶（最新在最上面）
function prepend(block: MsgBlock): void {
  messages.value.unshift(block)
}

function handleEvent(ev: MonitorEvent): void {
  switch (ev.type) {
    case 'meta':
      meta.value = { total: ev.total, truncated: ev.truncated }
      break
    case 'message': {
      // 历史回放 / 实时新写入：一行一块；已存在则跳过（正常不会重复，防御性去重）
      if (messages.value.some((m) => m.key === String(ev.id))) break
      prepend({
        key: String(ev.id),
        role: ev.role,
        content: ev.content,
        at: ev.at,
        streaming: false,
        truncated: false,
      })
      break
    }
    case 'assistant_delta': {
      // 流式增量：首个 delta 建块置顶，后续就地追加（v-html 原位更新，无闪烁）
      let block = messages.value.find((m) => m.key === ev.id)
      if (block === undefined) {
        block = { key: ev.id, role: 'assistant', content: '', at: Date.now(), streaming: true, truncated: false }
        prepend(block)
      }
      block.content += ev.content
      break
    }
    case 'assistant_done': {
      // 流式结束：块存在 → 定稿（时间 / 截断标记）；不存在（订阅晚于首个 delta）→ 凭完整文本补块
      let block = messages.value.find((m) => m.key === ev.id)
      if (block === undefined && ev.content !== '') {
        block = {
          key: ev.id,
          role: 'assistant',
          content: ev.content,
          at: ev.at,
          streaming: false,
          truncated: ev.truncated,
        }
        prepend(block)
      }
      if (block !== undefined) {
        block.streaming = false
        block.at = ev.at
        block.truncated = ev.truncated
      }
      break
    }
  }
}

// 抽屉打开 → 建立订阅；关闭 → 断开连接（停止监控）
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      void start()
    } else {
      stop()
      status.value = 'idle'
    }
  },
)

// 组件销毁时兜底断开
onBeforeUnmount(() => {
  stop()
})
</script>

<style scoped>
.monitor-drawer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

/* 状态栏 */
.monitor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.monitor-truncated {
  color: var(--el-text-color-warning);
}

.monitor-error {
  flex-shrink: 0;
}

.monitor-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 消息列表：滚动容器，新消息置顶无需自动滚动 */
.msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px;
}

/* 消息块：左侧色条按角色区分 */
.msg-block {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 8px 10px;
  word-break: break-word;
}

.role-user {
  border-left: 3px solid var(--el-color-primary);
}

.role-assistant {
  border-left: 3px solid var(--el-color-success);
}

.role-system {
  border-left: 3px solid var(--el-color-info);
}

.role-tool {
  border-left: 3px solid var(--el-color-warning);
}

.role-other {
  border-left: 3px solid var(--el-border-color);
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.msg-key {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-family: monospace;
}

/* 块下方时间：右对齐弱化显示 */
.msg-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  text-align: right;
}

/* markdown 渲染内容（v-html 产物在 scoped 之外，用 :deep 穿透；样式与 Chat 页一致） */
.md-body {
  font-size: 14px;
  line-height: 20px;
}


.md-body :deep(p) {
  margin: 0 0 8px;
}

.md-body :deep(:is(h1, h2,h3,h4)) {
  font-size: 14px;
  font-weight: bold;
}

.md-body :deep(p:last-child) {
  margin-bottom: 0;
}

.md-body :deep(pre) {
  margin: 0 0 8px;
  padding: 10px 12px;
  background: var(--el-fill-color-dark);
  border-radius: 6px;
  overflow-x: auto;
}

.md-body :deep(pre:last-child) {
  margin-bottom: 0;
}

.md-body :deep(code) {
  font-family: monospace;
  font-size: 13px;
}

.md-body :deep(a) {
  color: var(--el-color-primary);
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 12px;
}
</style>

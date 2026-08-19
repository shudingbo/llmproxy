<template>
  <div class="chat-page">
    <!-- 顶部：模型选择 + 能力图标 + 新会话 + API Key 状态 -->
    <div class="chat-header">
      <span class="header-label">模型</span>
      <el-select
        v-model="currentModel"
        placeholder="选择模型"
        class="model-select"
        :disabled="streaming"
      >
        <el-option v-for="alias in modelOptions" :key="alias" :label="alias" :value="alias" />
      </el-select>

      <!-- 当前别名能力并集：已知能力显示图标，未知能力显示灰色文字 chip -->
      <div v-if="capabilityItems.length > 0" class="cap-list">
        <template v-for="item in capabilityItems" :key="item.cap">
          <el-icon v-if="item.icon" :title="item.cap" class="cap-icon">
            <component :is="item.icon" />
          </el-icon>
          <el-tag v-else size="small" type="info" class="cap-unknown">{{ item.cap }}</el-tag>
        </template>
      </div>

      <div class="header-spacer" />

      <el-button :icon="RefreshRight" :disabled="streaming" @click="newSession">新会话</el-button>

      <!-- API Key 状态：仅后端开启鉴权（auth.enabled）时才要求 Key；
           未设置 = 红色标签 + 设置入口；已设置 = 绿色标签 + 清除；鉴权关闭时不展示任何 Key UI -->
      <template v-if="authEnabled">
        <template v-if="!apiKey">
          <el-tag type="danger" size="small">未设置 API Key</el-tag>
          <el-button size="small" type="primary" plain @click="openApiKeyDialog">设置 API Key</el-button>
        </template>
        <template v-else>
          <el-tag type="success" size="small">已配置 Key（前缀 {{ apiKeyMeta?.prefix ?? '' }}）</el-tag>
          <el-button size="small" type="danger" link @click="clearApiKey">清除</el-button>
        </template>
      </template>
    </div>

    <!-- 中部：消息流（滚动容器） -->
    <div ref="messagesEl" class="chat-messages">
      <div v-if="messages.length === 0" class="empty-hint">选择模型并发送消息开始对话</div>

      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        class="msg-row"
        :class="msg.role === 'user' ? 'msg-user' : 'msg-assistant'"
      >
        <div class="msg-bubble">
          <!-- 用户消息：纯文本 + 附件胶囊（hover 显示 文件名 / 大小 / 类型） -->
          <template v-if="msg.role === 'user'">
            <div v-if="msgText(msg) !== ''" class="msg-text">{{ msgText(msg) }}</div>
            <div v-if="msg.attachments && msg.attachments.length > 0" class="msg-attachments">
              <el-tag
                v-for="att in msg.attachments"
                :key="att.id"
                size="small"
                class="att-capsule"
                :title="`${att.file.name} · ${formatSize(att.size)} · ${att.mime}`"
              >
                {{ att.file.name }}
              </el-tag>
            </div>
          </template>
          <!-- 助手消息：markdown-it 渲染（html 选项保持关闭，用户输入按纯文本转义，防 XSS） -->
          <div v-else class="md-body" v-html="msg.contentHtml || ''"></div>
        </div>
      </div>
    </div>

    <!-- 底部：附件胶囊 + 输入框 + 发送/停止 -->
    <div class="chat-input">
      <!-- 已选附件胶囊：点 X 移除 -->
      <div v-if="attachments.length > 0" class="attach-bar">
        <el-tag
          v-for="att in attachments"
          :key="att.id"
          size="small"
          closable
          class="att-capsule"
          :title="`${att.file.name} · ${formatSize(att.size)} · ${att.mime}`"
          @close="removeAttachment(att.id)"
        >
          {{ att.file.name }}（{{ formatSize(att.size) }}）
        </el-tag>
      </div>

      <div class="input-row">
        <!-- 手动添加附件：不自动上传，只读 dataURL 进本地缓存 -->
        <el-upload
          ref="uploadRef"
          class="attach-upload"
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onFileChange"
          accept="image/*,.pdf,.txt,.md,.json,.csv,.docx,.xlsx"
          multiple
        >
          <el-button :icon="Paperclip" :disabled="streaming" title="添加附件（最多 5 个，单个 ≤1.5MB）" />
        </el-upload>

        <el-input
          v-model="inputText"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 8 }"
          placeholder="输入消息：Enter 发送，Shift+Enter 换行"
          class="chat-textarea"
          @keydown.enter.exact.prevent="send"
        />

        <el-button v-if="streaming" type="danger" @click="stopStream">
          <el-icon class="btn-icon"><VideoPause /></el-icon>
          停止
        </el-button>
        <el-button v-else type="primary" @click="send">发送</el-button>
      </div>
    </div>

    <!-- API Key 粘贴弹窗：明文 Key 的唯一入口（列表接口只回前缀，拿不到明文） -->
    <el-dialog
      v-model="apiKeyDialogVisible"
      title="设置 API Key"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetKeyDialog"
    >
      <el-alert type="info" :closable="false" show-icon class="key-dialog-alert">
        请填写在「API Keys」页面创建后的完整明文 Key。Key 仅保存在当前浏览器会话
        （sessionStorage）中，关闭页面即失效，不会上传到任何服务端。
      </el-alert>
      <el-input
        v-model="apiKeyInput"
        type="password"
        show-password
        placeholder="粘贴 API Key"
        autocomplete="off"
        class="key-input"
      />
      <template #footer>
        <el-button @click="apiKeyDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveApiKey">保存到本会话</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { ElMessage, type UploadFile } from 'element-plus'
import {
  Brush,
  ChatLineRound,
  Document,
  Edit,
  MagicStick,
  Microphone,
  Paperclip,
  Picture,
  RefreshRight,
  Tools,
  VideoPause,
} from '@element-plus/icons-vue'
import MarkdownIt from 'markdown-it'
import { api } from '../api/client'
import {
  createStreamChat,
  findApiKeyForUser,
  parseSseEvent,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatContentPart,
  type ChatMessage,
  type UploadedAttachment,
} from '../api/chat'
import { useAuthStore } from '../stores/auth'

// ========== 类型 ==========

// 后端裸候选（与 Models.vue 的 Candidate 同构，聊天页只关心能力字段）
type RawCandidate = { upstreamId: string; model: string; capabilities?: string[] }

// 后端裸别名条目（与 Models.vue 的 RawAliasEntry 一致）：
// 新形态 { disabled, candidates }；旧形态为裸候选数组（兼容历史配置）
type RawAliasEntry = { disabled?: boolean; candidates: RawCandidate[] } | RawCandidate[]

// 页面本地展示消息 = 线上 ChatMessage + 仅 UI 使用的扩展字段：
// - contentHtml：markdown-it 渲染出的 HTML。流式期间按 chunk 就地改写该字符串，
//   v-html 绑定随响应式更新在原地改写 DOM 文本，消息元素不重建、不闪烁
// - attachments：用户消息携带的附件胶囊（UI 展示用；发请求时展开进 content 数组）
type UiMessage = ChatMessage & {
  contentHtml?: string
  attachments?: UploadedAttachment[]
}

// 能力展示项：icon 为 null 表示未知能力（模板渲染灰色 chip）
type CapabilityItem = { cap: string; icon: Component | null }

// el-upload 句柄：只需 clearFiles() 清空组件内部文件缓存（同 Login.vue 的 ElInputHandle 做法）
interface ElUploadHandle {
  clearFiles: () => void
}

// ========== 常量 ==========

// 附件上限：最多 5 个；单文件 ≤ 1.5 MiB（发送前按字节数校验，先于 readAsDataURL）
const MAX_ATTACHMENTS = 5
const MAX_FILE_SIZE = 1.5 * 1024 * 1024

// 读取中的附件数量：多选时 el-upload 会对每个文件同步触发一次 on-change，
// 但 FileReader 回调是异步的——同步的 length 检查看不到「读取中」的文件，
// 必须把在途计数计入上限检查，否则一次选 6 个文件会绕过 5 个上限
let pendingReads = 0

// 能力 → 图标组件映射（未命中的能力在模板里降级为灰色文字 chip）
const CAPABILITY_ICONS: Record<string, Component> = {
  vision: Picture,
  tools: Tools,
  thinking: MagicStick,
  audio: Microphone,
  embedding: Document,
  completion: ChatLineRound,
  insert: Edit,
  reasoning: Brush,
}

// ========== 状态 ==========

const auth = useAuthStore()

// 模型下拉：可用别名（排除 disabled: true），保持配置插入顺序
const modelOptions = ref<string[]>([])
const currentModel = ref('')

// 别名 → 能力并集（onMounted 装载一次，页面内不再变化）
const aliasCapabilities = new Map<string, string[]>()

// 当前别名的能力并集：取该别名全部候选 capabilities 的集合并集
const capabilities = computed<string[]>(() => {
  if (!currentModel.value) return []
  return aliasCapabilities.get(currentModel.value) ?? []
})

// 能力展示项：已知能力带图标，未知能力 icon=null（渲染灰色 chip）
const capabilityItems = computed<CapabilityItem[]>(() =>
  capabilities.value.map((cap) => ({ cap, icon: CAPABILITY_ICONS[cap] ?? null })),
)

// 会话与密钥：
// - sessionId 在 onMounted 无条件重新生成（刷新页面 = 新会话，绝不复用旧值）
// - apiKey 仅存 sessionStorage（本会话有效），关闭页面即失效
const sessionId = ref('')

// 后端鉴权开关：auth.enabled 为 true 时才要求 API Key；关闭时 /v1 旁路鉴权，无需 Key
const authEnabled = ref(false)

const apiKey = ref('')
const apiKeyMeta = ref<{ prefix: string; source: 'session' | 'matched' } | null>(null)
const apiKeyDialogVisible = ref(false)
const apiKeyInput = ref('')

// 消息流（本地会话状态，不做任何持久化）与滚动容器
const messages = ref<UiMessage[]>([])
const messagesEl = ref<HTMLElement | null>(null)
const uploadRef = ref<ElUploadHandle>()

// 输入区与流控
const inputText = ref('')
const attachments = ref<UploadedAttachment[]>([])
const streaming = ref(false)
const abortController = ref<AbortController | null>(null)

// markdown-it 实例：linkify 自动识别链接、breaks 单换行转 <br>；
// html 选项保持关闭（默认值）——用户输入里的原始 HTML 一律被转义，这是本页面防 XSS 的硬约束
const md = new MarkdownIt({ linkify: true, breaks: true })

// ========== 工具函数 ==========

// 错误信息提取（与仓库其它页面同款：优先后端 msg/error，兜底原生 message）
function errMsg(err: unknown): string {
  const e = err as { response?: { data?: { msg?: string; error?: string } }; message?: string }
  return e.response?.data?.msg ?? e.response?.data?.error ?? e.message ?? '未知错误'
}

// Key 前缀掩码：保留前 4 位 + ****（明文绝不展示）
function maskKey(key: string): string {
  return key.length > 4 ? `${key.slice(0, 4)}****` : '****'
}

// 文件大小展示（B / KB / MB）
function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

// 用户消息展示文本（展示态 content 恒为字符串）
function msgText(msg: UiMessage): string {
  return typeof msg.content === 'string' ? msg.content : ''
}

// 滚到底部：nextTick 等 DOM 更新完成（新消息与流式 chunk 到达时调用，逐 chunk 调用即可）
function scrollToBottom() {
  void nextTick(() => {
    const el = messagesEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 消息条数变化（新消息 / 新会话清空）时滚到底
watch(
  () => messages.value.length,
  () => scrollToBottom(),
)

// ========== API Key 管理 ==========

// 打开 Key 粘贴弹窗（每次打开都从空输入开始）
function openApiKeyDialog() {
  apiKeyInput.value = ''
  apiKeyDialogVisible.value = true
}

// 弹窗关闭后清空明文输入，减少驻留
function resetKeyDialog() {
  apiKeyInput.value = ''
}

// 保存 Key 到本会话：先落 sessionStorage 再更新本地态，最后立刻清空明文输入框
function saveApiKey() {
  const val = apiKeyInput.value.trim()
  if (!val) {
    ElMessage.warning('请输入 API Key')
    return
  }
  sessionStorage.setItem('chat.apiKey', val)
  apiKey.value = val
  apiKeyMeta.value = { prefix: maskKey(val), source: 'session' }
  // 保存后立即清空明文输入，避免驻留在组件内存里
  apiKeyInput.value = ''
  apiKeyDialogVisible.value = false
  ElMessage.success('API Key 已保存到本会话')
}

// 清除本会话 Key：回到「未设置」状态
function clearApiKey() {
  sessionStorage.removeItem('chat.apiKey')
  apiKey.value = ''
  apiKeyMeta.value = null
}

// ========== 新会话 ==========

// 新会话：清空消息与附件、生成新 sessionId；若正在流式则先中止
function newSession() {
  if (streaming.value) abortController.value?.abort()
  messages.value = []
  attachments.value = []
  uploadRef.value?.clearFiles()
  sessionId.value = crypto.randomUUID()
}

// ========== 附件 ==========

// el-upload 回调（auto-upload=false，纯本地读取）：
// 先做数量 / 体积校验（体积校验在 readAsDataURL 之前，避免白读大文件），再读 dataURL 进缓存。
// 数量检查 = 已缓存数 + 读取中数（pendingReads），堵住多选并发绕过上限的竞态
function onFileChange(uploadFile: UploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (attachments.value.length + pendingReads >= MAX_ATTACHMENTS) {
    ElMessage.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
    return
  }
  if (file.size > MAX_FILE_SIZE) {
    ElMessage.warning('文件过大，单文件上限 1.5MB')
    return
  }
  // 同步计入在途读取（必须先于 readAsDataURL），onload / onerror 中扣减
  pendingReads += 1
  const reader = new FileReader()
  reader.onload = () => {
    pendingReads -= 1
    const dataUrl = typeof reader.result === 'string' ? reader.result : ''
    attachments.value.push({
      id: crypto.randomUUID(),
      file,
      dataUrl,
      // type 过滤后 mime 仍为空时按非图片处理（发送时以文本形式内嵌）
      mime: file.type || 'application/octet-stream',
      size: file.size,
    })
  }
  reader.onerror = () => {
    pendingReads -= 1
    ElMessage.error(`读取文件失败：${file.name}`)
  }
  reader.readAsDataURL(file)
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((a) => a.id !== id)
}

// ========== 发送与流式 ==========

// 组装线上消息（入参为「要纳入请求的消息列表」，由调用方裁剪）：
// - 助手消息：content 为累积文本
// - 用户消息：无附件时 content 为纯文本；有附件时展开为 content 数组——
//   文本段（非图片附件以 <attachment name=... mime=... size=...>base64</attachment>
//   行内嵌）+ 每个图片附件一个 image_url 段（dataURL 直接内联）
function buildWireMessages(msgs: UiMessage[]): ChatMessage[] {
  const wire: ChatMessage[] = []
  for (const m of msgs) {
    const text = typeof m.content === 'string' ? m.content : ''
    const atts = m.attachments ?? []
    if (m.role === 'assistant' || atts.length === 0) {
      wire.push({ role: m.role, content: text })
      continue
    }
    let textPart = text
    const parts: ChatContentPart[] = []
    for (const att of atts) {
      if (att.mime.startsWith('image/')) {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } })
      } else {
        const b64 = att.dataUrl.slice(att.dataUrl.indexOf(',') + 1)
        textPart += `\n<attachment name="${att.file.name}" mime="${att.mime}" size="${att.size}">${b64}</attachment>`
      }
    }
    parts.unshift({ type: 'text', text: textPart })
    wire.push({ role: 'user', content: parts })
  }
  return wire
}

// 解析单个 data 事件：取 choices[0].delta.content；坏 chunk 静默跳过
function extractDelta(data: string): string {
  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk
    const delta = chunk.choices?.[0]?.delta
    return delta?.content ?? ''
  } catch {
    return ''
  }
}

// 发送：校验 → 推用户消息 + 助手占位 → 消费 SSE 流逐块追加
async function send() {
  if (streaming.value) return
  const text = inputText.value.trim()
  if (!text && attachments.value.length === 0) return
  if (!currentModel.value) {
    ElMessage.warning('请先选择模型')
    return
  }
  // 仅后端开启鉴权时才强制要求 API Key；鉴权关闭时 /v1 旁路鉴权，空 Key 可正常请求
  if (authEnabled.value && !apiKey.value) {
    ElMessage.warning('请先设置 API Key')
    return
  }

  // 用户消息展示态：纯文本 + 附件胶囊（请求体另行按附件展开）
  const userMsg: UiMessage = { role: 'user', content: text, attachments: [...attachments.value] }
  // 助手占位消息：流式期间就地追加（同一条消息只创建一次）
  const assistantMsg: UiMessage = { role: 'assistant', content: '', contentHtml: '' }
  messages.value.push(userMsg, assistantMsg)
  scrollToBottom()

  const controller = new AbortController()
  abortController.value = controller
  streaming.value = true
  let ok = false
  try {
    // 尾部助手占位是纯 UI 态（此刻 content 还是空串），绝不能进线上请求：
    // 严格上游对空 assistant 轮次会 400，wire 请求必须以用户消息收尾
    const req: ChatCompletionRequest = {
      model: currentModel.value,
      messages: buildWireMessages(messages.value.slice(0, -1)),
      stream: true,
    }
    const stream = await createStreamChat(req, apiKey.value, sessionId.value, controller.signal)
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    // 未消费尾部缓冲：只取到最后一个完整 \n\n 为止，残片留给下一块拼接
    // （parseSseEvent 是无状态解析器，契约见 chat.ts 注释）
    let buffer = ''
    let acc = ''
    let finished = false
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const sep = buffer.lastIndexOf('\n\n')
      if (sep === -1) continue
      const completePart = buffer.slice(0, sep + 2)
      buffer = buffer.slice(sep + 2)
      for (const ev of parseSseEvent(completePart)) {
        if ('done' in ev) {
          finished = true
          break
        }
        const piece = extractDelta(ev.data)
        if (!piece) continue
        acc += piece
        // 就地改写：消息元素不重建，v-html 在 DOM 中原位更新文本，无闪烁
        assistantMsg.content = acc
        assistantMsg.contentHtml = md.render(acc)
        scrollToBottom()
      }
    }
    ok = true
  } catch (err: unknown) {
    // 用户主动停止（点「停止」或「新会话」触发 abort）不当错误提示
    if (controller.signal.aborted) return
    ElMessage.error(`发送失败：${errMsg(err)}`)
  } finally {
    streaming.value = false
    abortController.value = null
    // 仅在成功时清空输入与附件；中止 / 失败保留现场便于排查
    if (ok) {
      inputText.value = ''
      attachments.value = []
      uploadRef.value?.clearFiles()
    }
  }
}

// 停止流式：abort 底层 fetch，读取循环在 catch 中静默退出
function stopStream() {
  abortController.value?.abort()
}

// ========== 生命周期 ==========

onMounted(async () => {
  // 1) 拉取下游别名（排除 disabled: true），按插入顺序构建下拉与能力并集
  try {
    const { data } = await api.get<Record<string, RawAliasEntry>>('/downstream-models')
    const options: string[] = []
    for (const [alias, raw] of Object.entries(data)) {
      // 兼容两种裸形态：新 { disabled, candidates } / 旧裸候选数组
      const disabled = !Array.isArray(raw) && raw.disabled === true
      const candidates: RawCandidate[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw.candidates)
          ? raw.candidates
          : []
      if (disabled) continue
      const set = new Set<string>()
      for (const c of candidates) {
        for (const cap of c.capabilities ?? []) set.add(cap)
      }
      aliasCapabilities.set(alias, [...set])
      options.push(alias)
    }
    modelOptions.value = options
    // 自动选中第一个可用别名
    if (options.length > 0) currentModel.value = options[0]
  } catch (err) {
    ElMessage.error(`加载模型列表失败：${errMsg(err)}`)
  }

  // 0) 读取后端鉴权开关：决定是否需要 API Key（auth.enabled 为 true 才要求）
  try {
    const { data } = await api.get<{
      config?: { auth?: { enabled?: boolean } }
      auth?: { enabled?: boolean }
    }>('/config')
    // GET /admin/api/config 实际返回裸配置对象（无 config 信封，见 admin.ts）；兼容新契约 { config } 与裸形态
    const cfg = data.config ?? data
    authEnabled.value = cfg?.auth?.enabled === true
  } catch {
    authEnabled.value = false // 读不到配置按「无需鉴权」处理，避免误拦
  }

  // 2) 恢复本会话缓存的 API Key，并校验其是否仍然有效
  // （被删除 / 停用 / 过期则清除，避免发送时 401）
  const saved = sessionStorage.getItem('chat.apiKey')
  if (saved) {
    const username = auth.user?.username
    const meta = username ? await findApiKeyForUser(username) : null
    if (meta) {
      apiKey.value = saved
      apiKeyMeta.value = { prefix: meta.keyPrefix, source: 'matched' }
    } else {
      sessionStorage.removeItem('chat.apiKey')
      apiKey.value = ''
      apiKeyMeta.value = null
    }
  }

  // 3) 刷新页面 = 新会话：无条件生成全新 sessionId，不读取任何旧值
  sessionId.value = crypto.randomUUID()
})
</script>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ===== 顶部工具栏 ===== */
.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.header-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.model-select {
  width: 220px;
}

.cap-list {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cap-icon {
  font-size: 16px;
  color: var(--el-color-primary);
  cursor: default;
}

.cap-unknown {
  cursor: default;
}

.header-spacer {
  flex: 1;
}

/* ===== 消息流 ===== */
.chat-messages {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 4px;
  overflow-y: auto;
}

.empty-hint {
  margin: auto;
  font-size: 14px;
  color: var(--el-text-color-placeholder);
}

.msg-row {
  display: flex;
}

.msg-user {
  justify-content: flex-end;
}

.msg-assistant {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

/* 用户气泡：浅绿底（规格指定色值） */
.msg-user .msg-bubble {
  background: #dcfce7;
  border-bottom-right-radius: 2px;
}

/* 助手气泡：浅灰底（规格指定色值） */
.msg-assistant .msg-bubble {
  background: #f4f4f5;
  border-bottom-left-radius: 2px;
}

.msg-text {
  white-space: pre-wrap;
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.att-capsule {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}

/* markdown 渲染内容（v-html 产物在 scoped 之外，用 :deep 穿透） */
.md-body :deep(p) {
  margin: 0 0 8px;
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
  padding-left: 20px;
}

/* ===== 底部输入区 ===== */
.chat-input {
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.attach-upload {
  flex-shrink: 0;
}

.chat-textarea {
  flex: 1;
}

.btn-icon {
  margin-right: 4px;
}

/* ===== Key 弹窗 ===== */
.key-dialog-alert {
  margin-bottom: 12px;
}

.key-input {
  width: 100%;
}
</style>

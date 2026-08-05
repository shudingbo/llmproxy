# 会话管理页（Sessions）

管理界面的 **Sessions** 页用于查看和管理**会话亲和路由**的粘附映射：网关把同一会话的请求粘附到同一个上游，最大化 LLM 的 prompt cache 复用（同一段上下文反复命中同一上游，首 token 延迟与成本更低）。

粘附映射持久化在 SQLite（`~/llmproxy/llmproxy.db` 的 `sessions` 表），重启进程不丢失。

## 页面入口

管理界面左侧导航点击 **Sessions**。页面顶部是筛选栏与操作按钮，下方是映射表格与分页控件。

## 表格列说明

| 列 | 说明 |
| --- | --- |
| 会话 ID | 会话原始标识（如 Open WebUI 的聊天会话 UUID，或内容哈希），表格内显示前 10 位，悬停看全量 |
| 会话键 | 网关内部使用的粘附键，格式为 `虚拟模型::会话原始值`，表格内显示前 32 位 |
| Client | 会话键来源，彩色标签：`open-webui`（蓝）、`x-session-id`（深蓝）、`ywnrs`（红）、`content-hash`（绿）、`unknown`（橙） |
| 虚拟模型 | 下游模型别名（`downstreamModels` 的键） |
| 粘附上游 | 该会话当前粘附的上游 ID 与上游侧模型名 |
| 创建时间 / 更新时间 | 映射的创建与最近一次命中时间（本地时区） |
| 操作 | 该行的「解绑」按钮 |

## 筛选

| 条件 | 说明 |
| --- | --- |
| **客户端** | 下拉：全部 / `open-webui` / `x-session-id` / `ywnrs` / `content-hash` / `unknown`，**精确匹配** |
| **关键字** | 对 `session_id` 或 `upstream_id` 做模糊匹配，输入后回车或点「查询」立即生效 |

筛选条件变更同样防抖 300ms 自动刷新。列表按**更新时间倒序**（最近活动的会话在最前）。

## 分页

页码式分页：每页默认 **20** 条，可选 **10 / 20 / 50 / 100**，显示总条数，支持页码跳转。

> 与 Logs 页不同，Sessions 页**没有自动刷新**。查看过程中其他请求可能改变映射，需要手动点「查询」刷新。

## 操作

### 解绑（单条）

点某行「解绑」按钮，弹窗确认后调用 `DELETE /admin/api/sessions/:sessionKey`：

- 删除该会话的粘附记录
- 该会话**下次请求时重新选择上游**（不再强制走原来的上游）
- 幂等：会话已不存在时提示"会话不存在或已删除"

适用场景：怀疑某会话被粘附到了异常或慢的上游，想让它重新选一次。

### 清空全部

点「清空全部」按钮，二次确认后调用 `DELETE /admin/api/sessions`：

- 删除**全部**粘附映射
- 所有会话的下一次请求都会重新选择上游
- **不可恢复**，危险操作

适用场景：上游配置大改（增删上游、调权重）后，希望整体重新均衡。

### 立即清理

点「立即清理」按钮，调用 `POST /admin/api/sessions/cleanup`：

- 立即执行一次**过期清理**，删除超过保留期的会话映射
- 保留期取配置 `routing.sessionAffinity.cleanupMaxAgeMs`（默认 **1 周**；`0` 表示永不过期，此时该按钮返回删除 0 条）
- 完成后提示本次删除的条数

正常情况下过期清理由网关**自动执行**：启动时一次 + 每 `cleanupIntervalMs`（默认 1 小时）一次。手动按钮用于想在两个周期之间立刻清一次的场景。

## 会话键来源（对应 Client 列）

会话键由下游别名与会话原始值拼接：`虚拟模型::会话原始值`。会话原始值按优先级取自：

1. **HTTP header `X-OpenWebUI-Chat-Id`**（Open WebUI 专有头）：命中即作为会话值，Client 记为 `open-webui`
2. **HTTP header `X-Session-Id`**（部分客户端把会话 id 放在该通用 header）：命中即作为会话值。**值以 `ywnrs` 开头时**Client 记为 `ywnrs`，便于按客户端来源单独筛选；其余记为 `x-session-id`
3. **内容前缀哈希**：取请求体 `messages` 前 2 条（通常 system + 首条 user 消息）的 `role + content` 做 `sha256`，Client 记为 `content-hash`。无需客户端配合，相同前缀的请求自动汇聚到同一上游
4. **以上都取不到**：不建立粘附，走轮询，Client 记为 `unknown`

> 会话首条消息被编辑会导致内容哈希变化，视为新会话（会重新选上游）。这不影响正确性，反而最大化 cache 复用。

## 对应后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/sessions` | 分页列表：`?offset&limit&client&keyword`（updated_at 倒序），返回 `rows` / `total` |
| DELETE | `/admin/api/sessions/:sessionKey` | 解绑单条，返回 `{ deleted: boolean }` |
| DELETE | `/admin/api/sessions` | 清空全部，返回 `{ deleted: number }` |
| POST | `/admin/api/sessions/cleanup` | 立即过期清理（按 `cleanupMaxAgeMs`），返回 `{ deleted: number }` |

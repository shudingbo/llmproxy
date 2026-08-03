# 对接 Open WebUI

Open WebUI 是常见的 LLM Web 界面，通过 OpenAI 兼容接口接入上游。llmproxy 天然兼容这一模式：把 Open WebUI 的"连接 URL"指向 llmproxy 的 `/v1` 端点即可，同时 llmproxy 的**会话亲和路由**能为 Open WebUI 的每个聊天会话粘附到同一上游，最大化 prompt cache 复用。

## 场景

```
Open WebUI ──(OpenAI 兼容 /v1)──► llmproxy ──(按虚拟模型路由)──► 上游（OpenAI / DeepSeek / Ollama ...）
```

Open WebUI 只需要认识 llmproxy，llmproxy 负责把 `model`（虚拟模型名）解析成真实上游模型并按需回退。

## Open WebUI 侧配置

在 Open WebUI 的 **管理设置 → 连接（Connections）** 中：

| 配置项 | 值 |
| --- | --- |
| URL | `http://<llmproxy 所在机器地址>:3000/v1` |
| Key | 任意字符串（网关不校验客户端密钥，鉴权用配置里的上游 `apiKey`） |

注意：

- 地址要用 **Open WebUI 能访问到 llmproxy 机器的地址**，不能写 `127.0.0.1`（那会指向 Open WebUI 自己）。局域网部署一般写 `http://192.168.x.x:3000/v1`。
- 网关默认监听 `0.0.0.0:3000`，局域网内可直接访问；若被防火墙挡，放行该端口。

保存后，在模型选择器中选择 llmproxy 暴露的**虚拟模型名**（即配置文件 `downstreamModels` 的别名，如 `qwen3.5-9b`）。聊天时发送的 `model` 就是这个别名。

> llmproxy 的 `/v1/models` 返回的是下游别名列表，Open WebUI 会自动拉取并展示，无需手工填写模型名。

## 关键：开启用户信息头转发

**Open WebUI 默认不发送聊天会话标识**，会话亲和只能退化为"内容前缀哈希"兜底。要获得精确的会话级粘附，必须在 **Open WebUI 的环境变量**中设置：

```
ENABLE_FORWARD_USER_INFO_HEADERS=true
```

开启后，Open WebUI 会在每个请求中带上 `X-OpenWebUI-Chat-Id` 头（值为聊天会话的 UUID）。llmproxy 优先使用该头作为会话键（Client 记为 `open-webui`），同一聊天会话的所有请求稳定粘附到同一上游。

未开启时：

- 无 `X-OpenWebUI-Chat-Id` 头，llmproxy 退化为取请求体 `messages` 前 2 条的**内容前缀哈希**作为会话键（Client 记为 `content-hash`）
- 功能仍可用，只是同一会话内消息变化（如编辑了首条消息）会被视为新会话重新选上游，亲和精度略低

> 修改 Open WebUI 环境变量后需要**重启 Open WebUI 容器/进程**才生效。

### 自定义会话头名（可选）

Open WebUI 还支持环境变量 `FORWARD_SESSION_INFO_HEADER_CHAT_ID` 自定义转发给上游的 header 名：

```
FORWARD_SESSION_INFO_HEADER_CHAT_ID=My-Custom-Chat-Id
```

默认值即为 `X-OpenWebUI-Chat-Id`。**注意**：llmproxy 固定识别 `X-OpenWebUI-Chat-Id` 这个 header 名。如果把 Open WebUI 的转发头改成自定义名，llmproxy 将收不到会话键，会话亲和会回退到内容哈希兜底。因此一般**保持默认头名即可**，无需改这项。

## 验证会话亲和是否生效

1. 用 Open WebUI 发起几次同一会话的对话
2. 打开 llmproxy 管理界面 → **Sessions** 页
3. 应能看到 Client 为 `open-webui` 的映射，会话键形如 `qwen3.5-9b::<会话 UUID>`，粘附上游固定为某一个上游

若 Sessions 页只有 `content-hash` 的记录，说明 `ENABLE_FORWARD_USER_INFO_HEADERS` 未生效，请检查环境变量并重启 Open WebUI。

## 用 Ollama 兼容模式对接（可选）

部分基于 Ollama 生态的客户端（OLLAMA_HOST 模式）可走 llmproxy 的 `/api` 端点：

```bash
export OLLAMA_HOST=http://192.168.x.x:3000
ollama list        # 命中 GET /api/tags，列出下游别名
ollama run my-alias   # 命中 POST /api/chat
```

- 连接前客户端会探测 `GET /api/version`（返回 `0.5.12`），llmproxy 已实现
- `model` 同样填下游别名
- 限制：`/api/generate`、`/api/embed`、`/api/show` 未实现；`n > 1` 会被拒绝（400）

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| Open WebUI 显示连接失败 / 拉不到模型 | 检查连接 URL 的地址与端口是否可达；`/v1/models` 返回的是别名，确认 `downstreamModels` 至少有一个别名 |
| 模型选择器里没有想要的模型 | 该别名未配置在 `downstreamModels`，在管理端 Models 页新增 |
| Sessions 页全是 `content-hash` | `ENABLE_FORWARD_USER_INFO_HEADERS=true` 未设置或未重启 Open WebUI |
| 请求 404 / unknown model | `model` 拼写与别名不一致，或别名未配置 |

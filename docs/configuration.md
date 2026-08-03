# llmproxy 配置说明

本文档描述 `llmproxy.jsonc` 的完整配置结构、默认值与注意事项。**配置项以代码为准**，权威定义见 `server/src/config/schema.ts`（Zod schema 是单一事实来源），本文档与其逐字段核对。

## 配置文件位置

配置文件为 JSONC 格式（JSON with Comments，支持 `//` 注释与尾逗号），位于：

```
<userHome>/llmproxy/llmproxy.jsonc
```

- POSIX：`$HOME/llmproxy/llmproxy.jsonc`（例如 `/home/<you>/llmproxy/llmproxy.jsonc`）
- Windows：`%USERPROFILE%\llmproxy\llmproxy.jsonc`（例如 `C:\Users\<you>\llmproxy\llmproxy.jsonc`）

首次启动时若文件不存在，会自动生成一份带注释的示例配置，落盘权限 `0600`（仅属主可读写，保护明文 apiKey）。

修改保存后由文件监听（chokidar，200ms 防抖）自动热重载，**无需重启**。唯一例外是 `server` 监听配置（见下文）。重载失败不会阻塞启动，会保留旧配置并在管理界面与日志中显示告警（管理端可查 `GET /admin/api/config/reload-error`）。

## Schema 一览

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `upstreams[]` | array | 是（至少 1 个） | — | OpenAI 兼容上游提供商列表 |
| `upstreams[].id` | string | 是 | — | 唯一标识，被候选列表与路由引用 |
| `upstreams[].baseUrl` | string | 是 | — | 上游基础地址，必须是合法 URL |
| `upstreams[].apiKey` | string | 是 | — | 明文密钥（配置文件 0600 权限落盘） |
| `upstreams[].timeoutMs` | number | 否 | `30000` | 请求超时（毫秒），必须为正整数 |
| `upstreams[].disabled` | boolean | 否 | `false` | 暂停开关，`true` 时该上游不参与路由 |
| `downstreamModels` | object | 是 | — | 下游模型别名映射：key = 虚拟模型别名，value = 候选数组 |
| `downstreamModels[alias][]` | array | 是（至少 1 个候选） | — | 一个别名对应的有序候选列表 |
| `downstreamModels[alias][].upstreamId` | string | 是 | — | 须与某个 `upstreams[].id` 对应 |
| `downstreamModels[alias][].model` | string | 是 | — | 在上游侧使用的模型名 |
| `server` | object | 否 | — | 下行流监听配置（整节可缺省） |
| `server.host` | string | 否 | `127.0.0.1` | 监听地址（IPv4 / IPv6 / Unix socket 名） |
| `server.port` | number | 否 | `3000` | TCP 端口（1–65535） |
| `routing` | object | 否 | — | 路由行为配置（整节可缺省） |
| `routing.sessionAffinity` | object | 否 | `{}` | 会话亲和路由；允许只写部分键，其余取默认 |
| `routing.sessionAffinity.enabled` | boolean | 否 | `true` | 会话亲和总开关 |
| `routing.sessionAffinity.cleanupMaxAgeMs` | number | 否 | `604800000`（1 周） | 会话保留期（毫秒）；`0` = 永不过期 |
| `routing.sessionAffinity.cleanupIntervalMs` | number | 否 | `3600000`（1 小时） | 自动清理周期（毫秒）；`0` = 关闭自动清理调度 |

> 默认值说明：Zod 的 `.default()` / `.prefault()` 在解析时补齐缺省字段，因此 `upstreams[].timeoutMs`、`upstreams[].disabled`、`routing` 各键均可省略。`routing` 整节省略时按缺省值生效（会话亲和开启）；`server` 整节省略时进程按缺省监听 `0.0.0.0:3000`（`server/src/server/listen.ts` 的 `DEFAULT_HOST` / `DEFAULT_PORT`）。

## 完整配置示例

以下示例覆盖全部字段，可直接拷贝使用（请替换 `apiKey` 与地址为真实值）。`downstreamModels` 中 `qwen3.5-9b` 别名对应两个上游候选，多候选用于负载均衡与故障回退。

```jsonc
{
  // ---- server：下行流监听（可选；节内缺省 127.0.0.1:3000，整节省略时进程默认 0.0.0.0:3000）----
  // 注意：socket 在进程启动时绑定，修改本节必须重启进程才能生效
  "server": {
    "host": "0.0.0.0",   // 监听地址；0.0.0.0 表示对外网卡均可访问
    "port": 3000         // TCP 端口（1-65535）
  },

  // ---- upstreams：上游提供商列表（至少 1 个）----
  "upstreams": [
    {
      "id": "qwen3.5-9b-main",                    // 唯一标识，供候选列表引用
      "baseUrl": "http://222.18.149.200:1234/",   // 基础地址，必须是合法 URL
      "apiKey": "sk-REPLACE_ME",                  // 明文密钥（配置文件 0600 权限）
      "timeoutMs": 30000,                         // 请求超时（毫秒），默认 30000
      "disabled": false                           // 暂停开关，默认 false
    },
    {
      "id": "qwen3.5-9b-backup",
      "baseUrl": "http://222.18.149.10:1238/v1",
      "apiKey": "sk-REPLACE_ME",
      "timeoutMs": 30000,
      "disabled": false
    },
    {
      "id": "qwopus3.6-27b-v2",
      "baseUrl": "http://222.18.149.10:1236/v1",
      "apiKey": "sk-REPLACE_ME",
      "timeoutMs": 60000,
      "disabled": true   // 暂停中的上游不参与路由，可随时恢复
    }
  ],

  // ---- downstreamModels：下游别名 → 有序候选列表（每个别名至少 1 个候选）----
  // 聊天请求里的 model 必须用这里的别名（如 qwen3.5-9b），不能用上游原始模型名
  // 同一别名多个候选 = 轮询负载均衡 + 失败顺序回退（从轮询起点按列表顺序尝试）
  "downstreamModels": {
    "qwen3.5-9b": [
      {
        "upstreamId": "qwen3.5-9b-main",        // 须与 upstreams[].id 对应
        "model": "qwen3.5-9b-deepseek-v4-flash" // 在上游侧使用的模型名
      },
      {
        "upstreamId": "qwen3.5-9b-backup",
        "model": "qwen3.5-9b-deepseek-v4-flash"
      }
    ]
  },

  // ---- routing：路由行为（可选；整节可缺省，缺省即启用默认值）----
  // 会话亲和：同一会话的请求粘附到同一上游，最大化 prompt cache 复用
  "routing": {
    "sessionAffinity": {
      "enabled": true,               // 总开关，默认 true
      "cleanupMaxAgeMs": 604800000,  // 会话保留期，默认 1 周；0 = 永不过期
      "cleanupIntervalMs": 3600000   // 自动清理周期，默认 1 小时；0 = 关闭自动清理
    }
  }
}
```

## 字段说明与注意事项

### upstreams（上游）

- **`id`**：唯一标识，供 `downstreamModels` 的候选与路由引用。管理界面中不可修改。
- **`baseUrl`**：必须是合法 URL（Zod `z.string().url()` 校验）。以 `/v1` 结尾或裸主机地址均可，取决于上游服务。
- **`apiKey`**：明文存放。配置文件以 `0600` 权限落盘以保护密钥。密钥**绝不**出现在日志、管理接口响应或错误体中（管理接口只返回掩码值）。
- **`timeoutMs`**：单次上游请求的超时（毫秒），缺省 `30000`。超时属于可回退错误，会触发故障切换。
- **`disabled`**：暂停开关，缺省 `false`。暂停的上游在候选解析时被过滤，不再参与路由；管理界面显示 `Paused` 标签。

### downstreamModels（下游别名）

- **别名系统**：聊天请求（`/v1/chat/completions` 与 `/api/chat`）的 `model` 字段必须填**下游别名**（如 `qwen3.5-9b`）。填上游原始模型名会得到 `404 model_not_found`。模型列表接口（`/v1/models`、`/api/tags`）返回的也是别名列表。
- **`upstreamId`**：必须与某个 `upstreams[].id` 对应；管理界面删除上游时会级联清理引用它的候选。
- **同一别名多候选**：候选列表是有序的。新请求由轮询（round-robin）从 `count % 候选数` 选起点，随后按列表顺序逐个尝试：
  - 某一候选失败且**可回退**（网络错误、超时、HTTP `429`、HTTP `5xx`）时自动切到下一个候选；
  - 其它 `4xx`（如 `401` / `403` / `404`）不可回退，立即中断并把错误返回给客户端；
  - 全部候选失败返回 `502 {"error": "no_upstream"}`。
- **全部候选被暂停**：若某别名的所有候选都指向 `disabled` 上游，解析时被过滤后返回**原列表**并记警告，由回退逻辑处理（上层决策），不会直接报错。

### server（监听，可选）

- **`host`** / **`port`**：控制整个进程对外暴露的地址与端口。节内缺省 `127.0.0.1:3000`（schema 缺省值）；整节省略时进程缺省监听 `0.0.0.0:3000`（`listen.ts` 的 `DEFAULT_HOST` / `DEFAULT_PORT`）。`host` 设为 `0.0.0.0` 表示监听所有网卡，可被外部访问；生产部署时注意防火墙与鉴权（管理端 `/admin/api` 无内置鉴权，请在可信网络内使用）。
- **监听优先级**：命令行 `--host` / `--port` > `server` 节 > 缺省值。命令行参数最高优先级，host/port 相互独立可选，未指定的一侧回落下一优先级；也支持 `--host=0.0.0.0` / `--port=8080` 等号形式。**不再支持环境变量 `HOST` / `PORT` 覆盖监听地址**（0.2.0 起移除）。
- **需要重启**：socket 在进程启动时绑定，**修改本节或命令行参数的变更不会通过文件监听即时应用**（避免端口漂移 / 重复绑定），必须重启进程。例如 `pnpm start -- --host 0.0.0.0 --port 8080` 或 `node scripts/start.js --host 0.0.0.0 --port 8080`。

### routing（路由，可选）

- **`sessionAffinity`**：会话亲和路由的总开关与自动清理参数。整节可缺省；允许只写部分键，其余取默认。
  - **`enabled`**：总开关，缺省 `true`。关闭后所有请求回到轮询 + 回退行为。
  - **`cleanupMaxAgeMs`**：会话保留期（毫秒），缺省 `604800000`（1 周）。超过该时长的粘附映射会被清理；`0` 表示会话永不过期。
  - **`cleanupIntervalMs`**：自动清理的调度周期（毫秒），缺省 `3600000`（1 小时）；`0` 表示关闭自动清理调度（仍可手动触发，见管理端 Sessions 页的「立即清理」）。
- 会话键来源（优先级从高到低）：HTTP header `X-OpenWebUI-Chat-Id` → 请求体前 2 条消息的 `role + content` 的 sha256 → 都取不到则回退轮询。粘附映射持久化在 SQLite（`<userHome>/llmproxy/llmproxy.db` 的 `sessions` 表）。
- 粘附的上游被禁用 / 删除时自动重新选择；粘附请求回退到其它上游成功后自动改绑（绑定跟随实际可用性）。

### 热重载

- 除 `server` 监听配置外，其余配置（上游增删改、别名映射、路由参数）保存后**即时生效**，由文件监听自动重载，无需重启。
- 重载失败保留旧配置，不阻塞服务；错误可经 `GET /admin/api/config/reload-error` 查询，日志只记录错误码。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 请求返回 404 / 未知模型 | `model` 里填的是别名吗？检查 `downstreamModels` 中是否存在该别名 |
| 改了配置"没反应" | 检查文件是否为合法 JSONC、监听重载是否成功（`GET /admin/api/config/reload-error`） |
| 上游不可达 → 502 后回退 | 用 `POST /admin/api/upstreams/:id/test` 验证 `baseUrl` 可达性、`apiKey`、`timeoutMs` |
| 改了 host/port 不生效 | `server` 节或命令行 `--host` / `--port` 都在进程启动时绑定，需重启进程 |

# 日志管理页（Logs）

管理界面的 **Logs** 页用于浏览网关产生的日志。日志**双写**两份：按日轮转的日志文件（`~/llmproxy/logs/app-YYYY-MM-DD.log`、`api-YYYY-MM-DD.log`）与 SQLite（`~/llmproxy/llmproxy.db` 的 `logs` 表）。本页面的查询**直接读 SQLite**，不读文件。

## 页面入口

登录管理界面后，左侧导航点击 **Logs**。页面顶部是筛选栏，下方是日志表格与分页控件。

## 类型切换

顶部单选按钮在两种日志类型之间切换：

| 类型 | 内容 | 表格第 3 列 |
| --- | --- | --- |
| **App 日志** | 服务自身运行日志（启动、配置重载、清理等），有分类 | Category（如 `session-cleanup`、`log-cleanup`） |
| **API 日志** | 每个 HTTP 请求的访问日志，带 requestId | Request ID（显示前 8 位） |

切换类型会重新拉取列表（防抖 300ms 自动触发，无需点按钮）。

## 筛选条件

| 条件 | 说明 |
| --- | --- |
| **日期** | 必填，格式 `YYYY-MM-DD`，默认**今天**。只能查看选定这一天的日志 |
| **级别** | `all` / trace / debug / info / warn / error / fatal，默认 `all`。**阈值语义**：选 `info` 显示 info 及以上（info/warn/error/fatal）；选 `all` 包含全部级别 |
| **关键词** | 对消息内容做子串匹配，后端同时对 `msg` / `url` / `request_id` / `category` 四个字段做模糊匹配，任一命中即显示 |

任意筛选条件变更都会重置到第 1 页并自动刷新（防抖 300ms）。

## 分页

页码式分页，位于表格下方：

- 每页条数默认 **100**，可选 **50 / 100 / 200**（`limit`，后端上限 500）
- 显示**满足筛选条件的总条数**（`total`，不是"还剩多少页"）
- 支持页码跳转（jumper）
- 日志**最新在前**（按时间倒序），翻到第 2 页即查看更早的日志

## 自动刷新与"回到最新"

- 页面每 **5 秒**自动刷新一次，但**仅当停留在第 1 页**（最新日志）时
- 一旦翻页查看历史（`offset > 0`），页面顶部出现黄色横幅 **"正在查看历史日志，自动刷新已暂停"**，并显示「回到最新」按钮
- 点「回到最新」跳回第 1 页，恢复自动刷新

## 手动清理日志

筛选栏右侧提供手动清理入口：

1. 选择清理日期（默认 **7 天前**的今天，如今天为 8 月 10 日则默认 8 月 3 日）
2. 点 **「清理日志」**
3. 弹出二次确认：*"确认清理 <日期> 之前的全部日志？（SQLite 记录与日志文件都会删除，不可恢复）"*
4. 确认后调用 `POST /admin/api/logs/cleanup`，删除**所选日期当天零点之前**的全部日志

清理会同时删除：

- SQLite `logs` 表中 `time` 早于阈值的记录
- 日志目录中 `mtime` 早于阈值的 `app-*.log` / `api-*.log` 文件

完成后提示删除的条数（以及删除的文件个数），并回到第 1 页刷新。

> **不可恢复**：清理是物理删除，没有回收站。请谨慎操作。

## 自动保留期（无需人工操作）

网关自带自动清理，默认保留 **5 天**（启动时执行一次，之后每 6 小时一次）：

- 文件按 `mtime` 清理超过 5 天的 `app-*.log` / `api-*.log`
- DB 执行 `DELETE FROM logs WHERE time < now - 5天`

因此手动清理（默认 7 天）通常只会在自动保留期之上进一步精简，两者相互独立。

## 表格列说明

| 列 | 说明 |
| --- | --- |
| Time | 日志时间（本地时区） |
| Level | 级别彩色标签（trace 灰 / debug 绿 / info 蓝 / warn 橙 / error、fatal 红） |
| Category / Request ID | App 日志显示分类；API 日志显示请求 ID 前 8 位 |
| Message | 日志内容。API 日志的请求完成行会附带上下文，形如 `xxx GET /v1/models -> 200`（method、url、状态码） |

## 对应后端接口

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/admin/api/logs` | `type=app\|api`、`date=YYYY-MM-DD`（必填）、`level`、`keyword`、`offset`、`limit`（默认 100 上限 500），返回 `lines` / `total` / `hasMore` |
| POST | `/admin/api/logs/cleanup` | body `{ before?: epoch ms }`（缺省为 7 天前），返回 `{ deleted, deletedFiles, before }` |

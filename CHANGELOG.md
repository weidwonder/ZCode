# Changelog

## 未发布

### 不兼容

### 新增

- 桌面版本机任务 API：`<应用配置目录>/local-task-api.json` 写 `{"enabled":true,"port":47821,"token":"<≥32字符>"}` 后，桌面版在 `127.0.0.1:<port>` 提供任务驱动端点（`POST /api/tasks` 建任务、`POST /api/tasks/:id/messages` 补充输入（queue/steer）、`/stop`、`GET /api/tasks/:id`、`/events` 长轮询、`GET /api/tasks?workspacePath=` 列表）；经它建的任务是普通桌面对话，多对话并行、GUI 可见可接管。`GET /health` 免鉴权；其余端点要求 `Authorization: Bearer <token>`。见 `docs/local-task-api.md`。

### 变更

### 修复

### 内部

- 新增 main↔host 消息对 `LocalTaskApiRequest` / `LocalTaskApiResponse`（requestId 关联），Main 按 workspace 经 taskRealtimeBus hosts 注册表路由到拥有该工作区的窗口 Host；事件 ring buffer（每任务 500 条）在 Host 侧，Main 不承载任务业务状态。
- 曾实现的「本机 Webhook Bot 入站端点」（services 共享回调抽取、server 路由改造、UI webhook 入口）整体回退：webhook bot 单会话语义满足不了多对话并行与运行中补充消息（docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md）。

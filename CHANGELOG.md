# Changelog

## 未发布

### 不兼容

### 新增

- 桌面版本机任务 API：`<应用配置目录>/local-task-api.json` 写 `{"enabled":true,"port":47821,"token":"<≥32字符>"}` 后，桌面版在 `127.0.0.1:<port>` 提供任务驱动端点（`POST /api/tasks` 建任务（可选 `modelSelection` 指定模型与思考档位）、`POST /api/tasks/:id/messages` 补充输入、`/stop`、`GET /api/tasks/:id`、`/events` 长轮询、`GET /api/tasks?workspacePath=` 列表、`GET /api/models?workspacePath=` 列该工作区新建对话可选模型（与 GUI 新建对话同源投影）、`POST /api/tasks/:id/model` 给已有任务换模型）；经它建的任务是普通桌面对话，多对话并行、GUI 可见可接管。`GET /health` 免鉴权；其余端点要求 `Authorization: Bearer <token>`。messages 的 `delivery:"steer"` 与 GUI「运行中引导」同链路（sendPrompt 带 requestedDelivery:"guide"，CLI 即时注入或降级，结果经 `input.steered`/`steer.injected`/`steer.fellBack` 事件回报）；带 :taskId 的端点接受可选 `workspacePath`（GET query / POST body）用于重启后重锚定。见 `docs/local-task-api.md`。

### 变更

### 修复

### 内部

- 新增 main↔host 消息对 `LocalTaskApiRequest` / `LocalTaskApiResponse`（requestId 关联），Main 按 workspace 经 taskRealtimeBus hosts 注册表路由到拥有该工作区的窗口 Host；事件 ring buffer（每任务 500 条）在 Host 侧，Main 不承载任务业务状态；Host 退出时 Main 立即结清其在飞请求。
- create 支持可选 `clientRequestId` 幂等键（Main 侧 10 分钟去重窗口，in-flight 并发同 id 共享同一应答）与 `mode` 枚举白名单（对齐 ZCodeTaskMode 全集，非法 400，枚举单一来源 @zcode/shared；yolo 即 GUI「完全访问」档）；title 改名移到首条 prompt 之后（defer 持久化下此前 renameSession 报 Session not found after write——真机实测根因）；首条 prompt / 改名失败仍返回 201 带 `warning`（任务可接续、title 丢失可辨）；事件缓冲终态 10 分钟整体释放（懒重建，旧 after 回 `{resync:true}`）；长轮询唤醒只发 `after` 之后的新事件；开关文件 group/other 可读时打 warn 提醒 chmod 600。
- `IZCodeTaskService.sendPrompt` 新增可选 `requestedDelivery`（"startNow"|"queue"|"guide"），透传 v4 sendText 的同名字段——无界面路径获得与 GUI 完全一致的运行中引导（steer）原语；本机任务 API 的 steer/queue 改走该参数，废弃 enqueue+promote 近似（真机证实只是插队首）。带 attachments 时该参数不生效（legacy 发送路径，接口注释已写明）。
- 本机任务 API 第五轮修复：`input.steered` 事件的 `commandId` 取 CLI 事件的 `inputId`（= 202 应答的 commandId，关联键可对账；旧取 `pendingInputId` 带 `queue_` 前缀对不上）；空闲任务收到 steer 按实际去向应答 `delivery:"sent"`；`POST /:id/messages` 增加可选 `clientRequestId` 幂等键（每任务命名空间、10 分钟去重、in-flight 共享应答、命中回首次应答）。
- 本机任务 API 派发时选择模型：create 的 `modelSelection` 透传 `IZCodeTaskService.createTask`（strict schema 双层校验，deprecated 的 model/thoughtLevel 不用）；`GET /api/models` 复用 `IModelSelectionService.getView()`（GUI 新建对话同源：候选 providers[].models、思考档位 optionSpecs.reasoningLevel.values、默认 preferredSelection）投影精简结构；`POST /api/tasks/:id/model` 复用 `setModel` 换模型（运行中允许——GUI 仅 Highspeed 激活时锁，该状态 Host 侧不可见；clientRequestId 幂等独立 model 命名空间）。Main 传输纯工具与两条模型路由拆出 `localTaskApiHttpUtil.ts` / `localTaskApiModelRoutes.ts`（守 800 行 lint 上限）。
- 曾实现的「本机 Webhook Bot 入站端点」（services 共享回调抽取、server 路由改造、UI webhook 入口）整体回退：webhook bot 单会话语义满足不了多对话并行与运行中补充消息（docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md）。

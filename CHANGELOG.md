# Changelog

## 未发布

### 不兼容

### 新增

- 桌面版本机任务 API：`<应用配置目录>/local-task-api.json` 写 `{"enabled":true,"port":47821,"token":"<≥32字符>"}` 后，桌面版在 `127.0.0.1:<port>` 提供任务驱动端点（`POST /api/tasks` 建任务（可选 `modelSelection` 指定模型与思考档位）、`POST /api/tasks/:id/messages` 补充输入、`/stop`、`GET /api/tasks/:id`、`/events` 长轮询、`GET /api/tasks?workspacePath=` 列表、`GET /api/models?workspacePath=` 列该工作区新建对话可选模型（与 GUI 新建对话同源投影）、`POST /api/tasks/:id/model` 给已有任务换模型；workspace 未在任何窗口打开时自动打开再派发（与 deep link/--open-workspace/Finder 同一条 handleOpenWorkspacePath 链路、当前窗口加标签，30s 有界等待 Host 注册、同 workspace 并发去重；路径无效 400 `workspace_path_invalid`、进程级拦截 409 `workspace_open_blocked`、超时 409 `workspace_open_timeout`））；经它建的任务是普通桌面对话，多对话并行、GUI 可见可接管。`GET /health` 免鉴权；其余端点要求 `Authorization: Bearer <token>`。messages 的 `delivery:"steer"` 与 GUI「运行中引导」同链路（sendPrompt 带 requestedDelivery:"guide"，CLI 即时注入或降级，结果经 `input.steered`/`steer.injected`/`steer.fellBack` 事件回报）；带 :taskId 的端点接受可选 `workspacePath`（GET query / POST body）用于重启后重锚定。见 `docs/local-task-api.md`。

### 变更

### 修复

- 本机任务 API 第五轮修复：`input.steered` 事件的 `commandId` 取 CLI 事件的 `inputId`（= 202 应答的 commandId，关联键可对账；旧取 `pendingInputId` 带 `queue_` 前缀对不上）；空闲任务收到 steer 按实际去向应答 `delivery:"sent"`；`POST /:id/messages` 增加可选 `clientRequestId` 幂等键（每任务命名空间、10 分钟去重、in-flight 共享应答、命中回首次应答）。
- 修复（上游）：`turn.steerQueued` 协议 schema 补 `inputPresentation` 可选字段（7 值枚举，与 CLI contracts 的 RuntimeInputPresentationSchema 同枚举）——CLI 发该字段时桌面 strict 校验以 unrecognized_keys 丢弃整条事件，`input.steered` 永不到达（真机 2026-10-28 日志实锤，GUI 同受影响）；补 7 值全过+未知值拒的 schema 测试。
### 内部

- 新增 main↔host 消息对 `LocalTaskApiRequest` / `LocalTaskApiResponse`（requestId 关联），Main 按 workspace 经 taskRealtimeBus hosts 注册表路由到拥有该工作区的窗口 Host；事件 ring buffer（每任务 500 条）在 Host 侧，Main 不承载任务业务状态；Host 退出时 Main 立即结清其在飞请求。
- create 支持可选 `clientRequestId` 幂等键（Main 侧 10 分钟去重窗口，in-flight 并发同 id 共享同一应答）与 `mode` 枚举白名单（对齐 ZCodeTaskMode 全集，非法 400，枚举单一来源 @zcode/shared；yolo 即 GUI「完全访问」档）；title 改名移到首条 prompt 之后（defer 持久化下此前 renameSession 报 Session not found after write——真机实测根因）；首条 prompt / 改名失败仍返回 201 带 `warning`（任务可接续、title 丢失可辨）；事件缓冲终态 10 分钟整体释放（懒重建，旧 after 回 `{resync:true}`）；长轮询唤醒只发 `after` 之后的新事件；开关文件 group/other 可读时打 warn 提醒 chmod 600。
- `IZCodeTaskService.sendPrompt` 新增可选 `requestedDelivery`（"startNow"|"queue"|"guide"），透传 v4 sendText 的同名字段——无界面路径获得与 GUI 完全一致的运行中引导（steer）原语；本机任务 API 的 steer/queue 改走该参数，废弃 enqueue+promote 近似（真机证实只是插队首）。带 attachments 时该参数不生效（legacy 发送路径，接口注释已写明）。
- 本机任务 API 派发时选择模型：create 的 `modelSelection` 透传 `IZCodeTaskService.createTask`（strict schema 双层校验，deprecated 的 model/thoughtLevel 不用）；`GET /api/models` 复用 `IModelSelectionService.getView()`（GUI 新建对话同源：候选 providers[].models、思考档位 optionSpecs.reasoningLevel.values、默认 preferredSelection）投影精简结构；`POST /api/tasks/:id/model` 复用 `setModel` 换模型（运行中允许——GUI 仅 Highspeed 激活时锁，该状态 Host 侧不可见；clientRequestId 幂等独立 model 命名空间）。Main 传输纯工具与两条模型路由拆出 `localTaskApiHttpUtil.ts` / `localTaskApiModelRoutes.ts`（守 800 行 lint 上限）。
- 模型选择加固（真机反馈）：`GET /api/models` 每模型加 `defaultThoughtLevel`（GUI 新建对话同源默认=最高档 values.at(-1)，与 completeNewModelSelection 一致；无档位模型不给）；create 与 `POST /:id/model` 的 modelSelection 经 `getView({selection})` 预检——缺 reasoningLevel 且模型有档位时自动补同一默认、注册表可判定失败（provider/model 不存在、账号态不可用、档位不支持）回 `400 invalid_model_selection`（不再 503）、无 issue 透传 effectiveSelection（account-plan providerId 归一）。
- 第七轮修复：workspace 自动打开等待期每 2s 重发 openWorkspace（治愈上游 pendingOpenWorkspaceRequest 单槽在跨 workspace 并发下的后到覆盖先到；重发幂等——renderer 对已开目录只激活标签）；open 失败日志去除 workspacePath 改 `request=<requestId>` 关联；上游文档 Limitations 的 modelSelection 预检矛盾、远端 workspace 错误码口径、GET /api/models 自动打开口径同步修正；conversation-protocol-declaration 的 steerQueued 字段清单补 inputPresentation。
- workspace 自动打开：`localTaskApi.ts` 经注入的 openWorkspace（main/index.ts 实现：强制升级 blocked、isValidLocalWorkspaceDirectory invalid、无窗 ensurePrimaryWindow、handleOpenWorkspacePath 同链路）在 dispatcher 未命中 Host 时打开工作区并轮询等待注册；等待/去重/错误码收敛在新模块 `localTaskApiWorkspaceOpener.ts`（30s 上限、250ms 轮询、同 workspace in-flight 共享、settle 即清）。
- 曾实现的「本机 Webhook Bot 入站端点」（services 共享回调抽取、server 路由改造、UI webhook 入口）整体回退：webhook bot 单会话语义满足不了多对话并行与运行中补充消息（docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md）。

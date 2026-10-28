# 业务域卡 — ZCode › local-task-api

## 职责
桌面版本机任务 API：外部本机程序经 loopback HTTP 驱动普通桌面对话（建任务/发消息/停止/查询/事件），多对话并行、运行中可补充输入、GUI 实时可见。

## 权威实现与对外接口

| 能力 / 入口 | 权威实现（cite） | 类型 | 版本 / 状态 | 调用方 / 触发源 | 约束 |
|---|---|---|---|---|---|
| 任务服务业务面（createTask/sendPrompt（支持 requestedDelivery=startNow/queue/guide，底层 v4 sendText）/stop/snapshot/active/事件订阅） | `packages/services/src/session/zcodeTaskService.ts#IZCodeTaskService` | 内部 | canonical | Host responder（Pick 面） | createTask+sendPrompt 参数形态照抄 host/index.ts 无界面派发先例；running 判定只能用 listActiveTaskIds；引导/入队与 GUI 同链路（CLI inputRouting 裁决） |
| 无界面派发先例（createTask→sendPrompt） | `packages/desktop/src/host/index.ts#dispatchOffPeakRun` | 内部 | canonical | 闲时任务 | deferPersistenceUntilFirstPrompt:true；clientMode "desktop-continuous"；续聊 traceId 用新 uuid |
| waiting 判定（runtime 快照字段） | `packages/shared/src/zcode-task-types-core.ts`（ZCodeSessionRuntimeSnapshot 的 pendingPermissions/pendingElicitations；meta.pendingInteraction 是 sessions-index 摘要、非本 API 判定源） | 内部 | canonical | get 五态 | 判定序：pending 两类 → running（listActiveTaskIds）→ error（meta.status）→ idle |
| 流事件类型判别（turn/权限/完成/失败） | `packages/shared/src/zcode-task-types-core.ts#ZCodeStreamEvent` | 内部 | canonical | 事件投影 | task_run_started/task_complete/task_error/permission_request 是粗粒度投影源；终态后 10 分钟整体释放订阅与缓冲（懒重建） |
| workspace→Host 路由数据源 | `packages/desktop/src/main/taskRealtimeBus.ts#TaskRealtimeBus`（hosts 注册表） | 内部 | canonical | Main 路由函数 | workspaceKey = workspaceIdentity?.trim() \|\| workspacePath；renderer 经 SyncWindowTabs 上报（desktopMainIpcPlatform.ts） |
| Main 监听与鉴权 | `packages/desktop/src/main/localTaskApi.ts#createLocalTaskApi` | HTTP(loopback) | v2 | 桥接程序 | 开关文件 local-task-api.json（enabled/port/token≥32）；Host 头→Bearer(sha256+timingSafeEqual)→Content-Type→16MiB |
| taskId 重锚定（重启后接续） | Main 侧 `resolveTaskWorkspace`（同上文件）；Host 校验用 `packages/services/src/session/zcodeTaskService.ts#IZCodeTaskService` 的 getTaskMeta | 内部 | v2 | 桥接程序 | 归属表未命中 + 请求带 workspacePath → Host getTaskMeta 核实（null→404）→ 2xx 回填归属表；未命中未带 → 404 |
| Host 应答器（九 op + 事件 ring buffer） | `packages/desktop/src/host/localTaskApiResponder.ts#createLocalTaskApiResponder` | 内部 | v2 | Main 转发 | buffer 每任务 500 条；resync 语义；事件缓冲在 Host（Main 不承载业务状态）；send/stop/setModel/events 前置 getTaskMeta 归属校验 |
| workspace 自动打开（未打开 → 打开后派发） | 注入实现 `packages/desktop/src/main/index.ts`（openWorkspace deps）→ 共用函数 `packages/desktop/src/main/desktopOAuthDeepLink.ts#handleOpenWorkspacePath`（与 deep link/--open-workspace/Finder 同链路，当前窗口加标签）；等待/去重/错误码在 `packages/desktop/src/main/localTaskApiWorkspaceOpener.ts` | 内部 | v2 | Main dispatcher 未命中 Host 时 | 30s 有界等待、同 workspace 并发去重；invalid=400/blocked=409/timeout=409；只对本地路径生效 |
| 模型候选投影（/api/models，GUI 新建对话同源） | `packages/services/src/model-provider/providerFacadeServices.ts#IModelSelectionService`（getView，本地容器装配 `packages/services/src/node.ts:2984-2984`）；GUI 分组先例 `packages/ui/src/lib/modelSelectionGroups.ts:33-78`、思考档位 `packages/ui/src/lib/modelThoughtOption.ts:5-34`（optionSpecs.reasoningLevel.values）、默认 automation 先例 `packages/desktop/src/host/automationModelSelection.ts:23-27` | 内部 | canonical | /api models 投影 | thoughtLevels 缺失 → 空数组；defaultThoughtLevel=values.at(-1)（GUI 同源默认=最高档，无档位不给）；isDefault 按顶层 preferredSelection 命中；不做 GUI selectedProvider 菜单过滤 |
| 任务换模型（/:id/model） | `packages/services/src/session/zcodeTaskService.ts#IZCodeTaskService`（setModel，adapter 直发 runtime，`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:2859-2873`） | 内部 | canonical | /:id/model op | create/:id/model 均经 getView({selection}) 预检：可判定失败 400 invalid_model_selection、缺档位补 GUI 同源默认、无 issue 透传 effectiveSelection；运行中允许（GUI 仅 Highspeed 锁，packages/ui/src/v4/SessionPane.tsx:4408-4415；Highspeed 是 UI 运行态 Host 不可见，agent 拒绝 → 503）；clientRequestId 幂等独立 model 命名空间（key 前缀 `model\0` 与 send 隔离） |

## 陷阱项

- GUI v4 新建对话不走 IZCodeTaskService（走 v4 协议 createSession/sendText 命令） — 无界面建任务必须用 createTask（tasks-index 可见、GUI 能打开），不要试图从 Main 模拟 GUI 命令链
- enqueueTaskCommand+promoteTaskCommand 当 steer 用 — 真机证实只是插队首不是即时引导；运行中引导的正确原语是 sendPrompt 带 requestedDelivery:"guide"（sendPrompt 底层即 v4 sendText，zcodeTaskServiceAdapter.ts:457-477）
- deferPersistenceUntilFirstPrompt 的任务在首条 prompt 前 renameTask — session 未落盘，renameSession 报 Session not found after write；改名必须在 sendPrompt 之后
- 自己拼模型候选列表 — 唯一来源是 IModelSelectionService.getView()（GUI 新建对话同一条）；思考档位在模型 config.optionSpecs.reasoningLevel.values（GUI 投影先例 resolveModelThoughtOption），deprecated 的 createTask model/thoughtLevel 字段不要用
- 自己挑默认思考档位 — GUI 新建对话的默认是最高档 values.at(-1)（completeNewModelSelection，packages/provider/src/model-selection-config.ts:58-73），API 补齐与 /api/models 的 defaultThoughtLevel 必须同源同值，别按「最低档/中间档」自定
- 自己造「打开工作区」的窗口策略（新窗口/前台抢占） — 必须复用 handleOpenWorkspacePath（当前窗口加 workspace 标签、tab 去重）；等待 Host 注册有 30s 上限，超时如实 409 workspace_open_timeout
- 给换模型端点加「运行中 409」 — GUI 普通运行中不锁模型（仅 Highspeed 卡激活时锁）；Highspeed 是 UI 运行态 Host 侧拿不到，别在 API 层臆造禁止条件

## 测试入口

- `packages/desktop/test/localTaskApiResponder.test.ts`、`packages/desktop/test/localTaskApi.test.ts`（mock IZCodeTaskService，Pick 面类型绑定）

## 确认
2026-10-28｜来源：packages/services/src/session/zcodeTaskService.ts、packages/desktop/src/host/index.ts、packages/desktop/src/main/taskRealtimeBus.ts、packages/shared/src/zcode-task-types-core.ts、packages/services/src/model-provider/providerFacadeServices.ts、packages/provider/src/facades.ts、packages/ui/src/lib/modelSelectionGroups.ts、packages/ui/src/lib/modelThoughtOption.ts、packages/ui/src/v4/ConversationComposer.tsx、packages/ui/src/v4/SessionPane.tsx（GUI 语义：引导与换模型）、packages/desktop/src/main/desktopOAuthDeepLink.ts（打开工作区链路）

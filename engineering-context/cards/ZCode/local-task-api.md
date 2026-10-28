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
| Host 应答器（六 op + 事件 ring buffer） | `packages/desktop/src/host/localTaskApiResponder.ts#createLocalTaskApiResponder` | 内部 | v2 | Main 转发 | buffer 每任务 500 条；resync 语义；事件缓冲在 Host（Main 不承载业务状态）；send/stop/events 前置 getTaskMeta 归属校验 |

## 陷阱项

- GUI v4 新建对话不走 IZCodeTaskService（走 v4 协议 createSession/sendText 命令） — 无界面建任务必须用 createTask（tasks-index 可见、GUI 能打开），不要试图从 Main 模拟 GUI 命令链
- enqueueTaskCommand+promoteTaskCommand 当 steer 用 — 真机证实只是插队首不是即时引导；运行中引导的正确原语是 sendPrompt 带 requestedDelivery:"guide"（sendPrompt 底层即 v4 sendText，zcodeTaskServiceAdapter.ts:457-477）
- deferPersistenceUntilFirstPrompt 的任务在首条 prompt 前 renameTask — session 未落盘，renameSession 报 Session not found after write；改名必须在 sendPrompt 之后

## 测试入口

- `packages/desktop/test/localTaskApiResponder.test.ts`、`packages/desktop/test/localTaskApi.test.ts`（mock IZCodeTaskService，Pick 面类型绑定）

## 确认
2026-10-28｜来源：packages/services/src/session/zcodeTaskService.ts、packages/desktop/src/host/index.ts、packages/desktop/src/main/taskRealtimeBus.ts、packages/shared/src/zcode-task-types-core.ts、packages/ui/src/v4/ConversationComposer.tsx（GUI 语义调查）

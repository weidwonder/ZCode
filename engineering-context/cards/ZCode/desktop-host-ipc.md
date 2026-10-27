# 业务域卡 — ZCode › desktop-host-ipc

## 职责
Electron Main 与各窗口 window-scoped Local Host（utilityProcess）之间的进程间消息协议、请求转发与服务容器拓扑。

## 权威实现与对外接口

| 能力 / 入口 | 权威实现（cite） | 类型 | 版本 / 状态 | 调用方 / 触发源 | 约束 |
|---|---|---|---|---|---|
| 消息类型清单（main→host / host→main） | `packages/shared/src/channels.ts#HostMessageTypes`、同文件 `HostResponseTypes` | 内部协议 | canonical | Main/Host 双侧 | 新消息必须同时加 zod schema 并挂进 hostIncomingMessageSchema / hostResponseMessageSchema（packages/shared/src/validation.ts:962/1563） |
| Host 侧消息入口与分发 | `packages/desktop/src/host/index.ts#parentPort`（on("message") 分发） | 内部 | canonical | Main postMessage | 每个消息一个 case；activeServices 在 InitLocal 后可用 |
| Main→Host requestId 请求模式（先例） | `packages/desktop/src/main/resourceManagerHostSampling.ts#requestHostResourceUsage` | 内部 | canonical | 资源管理器 | pending Map 按 requestId 等应答 + 超时兜底 + cancel；新请求照此形态 |
| Main 侧存活 Host 表与「任一本地 host」选择 | `packages/desktop/src/main/index.ts#windowHostProcessMap`、同文件 `resolveCronDispatchHost` | 内部 | canonical | cron scheduler 等 | Map<webContentsId, utilityProcess>；Host 消亡由 desktopWindowLifecycle.ts 维护删除 |
| Host 内 services 容器（bots/任务服务宿主） | `packages/desktop/src/host/index.ts#initializeServices`（InitLocal→createLocalServices）；注册在 packages/services/src/node.ts#createLocalServices | 内部 | canonical | 每窗口 Host | 每窗口一份 IBotsService/IZCodeTaskService；配置/状态共享文件，channel runtime 靠跨进程文件锁互斥（telegramChannelRuntime.ts#acquireTelegramPollingLock）。无界面派发先例（createTask+sendPrompt）在同文件 dispatchOffPeakRun |
| Main→Host 请求转发（本机任务 API） | `packages/desktop/src/main/localTaskApi.ts#createLocalTaskApi`；Host 侧 `packages/desktop/src/host/localTaskApiResponder.ts#createLocalTaskApiResponder` | HTTP(loopback)+postMessage | v2 | 桥接程序 | 全应用唯一；开关文件 getAppConfigDir()/local-task-api.json；workspace→Host 路由走 taskRealtimeBus hosts 注册表（回退史见 docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md） |

## 陷阱项

- Main 进程直接 `get(IBotsService)` — Main 没有 bots 服务实例（只有每个窗口 Host 内有），Main 侧需要 bots 能力必须经 postMessage 转发给 Host，改用 `resolveCronDispatchHost` 同款「任一存活 Host」+ requestId 请求
- `@zcode/rpc` ChannelClient 从 Main 连回 Host — 无先例且叠在已有 postMessage 协议之上，不要为此新建 RPC 客户端

## 测试入口

- `packages/desktop/test/windowTopicResourceRelay.test.ts`、`packages/desktop/test/connectDesktopSourceServer.test.ts`（host 子模块单测形态）
- `packages/desktop/test/localTaskApi.test.ts`、`packages/desktop/test/localTaskApiResponder.test.ts`（本机任务 API）

## 日志与排障

- Main 用 packages/desktop/src/main/logger.ts 的 logger；Host 用 host logger；requestId 是跨进程关联键

## 确认
2026-10-28｜来源：packages/desktop/src/main/{index.ts,desktopHostProcess.ts,desktopWindowLifecycle.ts,resourceManagerHostSampling.ts,localTaskApi.ts,taskRealtimeBus.ts}、packages/desktop/src/host/{index.ts,localTaskApiResponder.ts}、packages/shared/src/{channels.ts,validation.ts}

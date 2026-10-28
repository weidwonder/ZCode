---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-28'
authority_refs:
  - '本机任务 API 端点契约（health/auth/tasks/messages/stop/get/events/list/models/tasks-:id-model，见 docs/local-task-api.md）'
  - '开关文件 local-task-api.json 的读取与鉴权语义（enabled/port/token）'
  - 'main↔host 消息对 LocalTaskApiRequest / LocalTaskApiResponse 的 payload 契约'
  - '五态投影与事件类型投影（IZCodeTaskService → HTTP 字段）'
---

# ZCode_技术 Spec — 桌面版本机任务 API（契约 v2）

> 单仓库详细技术规范。dw 专属产物（随 `chore(local-dw):` 提交）；上游文档另见 `docs/local-task-api.md`。
> 取代 2026-10-27 的 webhook bot 入站方案（v1，已全部回退）；变更原因见 `docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md`。

## 0. 阅读导引（MUST，前置）

- **一句话目的**：外部本机程序通过 loopback HTTP 以「普通桌面对话」的方式驱动 ZCode 任务——多对话并行、运行中可补充消息、GUI 实时可见且可接管。
- **端到端场景**：
  1. 桥接 setup 写 `<appConfigDir>/local-task-api.json`（0600）→ 用户启动 ZCode → Main 读开关文件起 `127.0.0.1:47821` 监听 → 桥接 `GET /health` 得 `{api:"zcode-local-task-api",version:2}`。
  2. 桥接 `POST /api/tasks`（Bearer token，workspace 已在某窗口打开）→ Main 按 workspace 路由到拥有它的窗口 Host → Host 调 `IZCodeTaskService.createTask`（与闲时派发同模式）+ 订阅事件 + `sendPrompt` 首条 → `201 {taskId}`；GUI 任务列表立即可见。
  3. 桥接 `POST /api/tasks/:id/events?after=0&waitMs=25000` 长轮询取粗粒度事件；任务运行中再 `POST /api/tasks/:id/messages`（queue/steer）补充输入；`POST /api/tasks/:id/stop` 停止。
  4. 异常：workspace 未在任何窗口打开 → 409 `workspace_not_open`；token 错 → 401；Host 头非法 → 403；无存活 Host → 503；taskId 不在 Main 归属表 → 404。
- **核心流程图**：
  ```mermaid
  flowchart TD
    A[Main whenReady] --> B[读 local-task-api.json]
    B -->|缺失/损坏/enabled!=true/token<32B| X[不监听]
    B -->|ok| C[listen 127.0.0.1:port]
    C --> D{请求}
    D -->|GET /health| E[200 直接回]
    D -->|其它| F[Host 头校验→Bearer 鉴权→JSON Content-Type→16MiB]
    F -->|违规| G[403/401/415/413]
    F -->|通过| H{op}
    H -->|create/list| I[按 workspacePath 路由到拥有 Host]
    H -->|send/stop/get/events| J[查 Main taskId→workspace 表 → 路由]
    I -->|无拥有 Host| K[409 workspace_not_open]
    J -->|表 miss| L[404]
    I -->|有| M[requestId postMessage → Host responder → IZCodeTaskService]
    J -->|有| M
    M --> N[status+body 透传]
  ```
- **决策表**：

| 输入 / 状态 | 条件 | 走向 | 结果 |
|---|---|---|---|
| 开关文件 | 缺失 / 损坏(warn) / enabled≠true / token 长度<32 | 不监听 | 无监听 |
| `GET /health` | 任何（无鉴权） | 直接回 | 200 `{ok,api,version,zcodeVersion}` |
| 任意 API 请求 | Host 头 ∉ {127.0.0.1:port, localhost:port} | 403（读 body 前） | — |
| 任意 API 请求 | Authorization ≠ `Bearer <token>`（常量时间比较） | 401 | — |
| POST | Content-Type 不含 `application/json` | 415 | — |
| POST | body > 16 MiB | 413（回包后断连） | — |
| create / list | workspacePath 无拥有 Host | 409 `{"error":"workspace_not_open"}` | — |
| send/stop/get/events | taskId 不在 Main 归属表 | 404 `{"error":"task_not_found"}` | — |
| send/stop/get/events | 归属 workspace 已无拥有 Host | 409 `workspace_not_open` | — |
| 任意转发 | 无存活 Host / Host 应答失败 / 超时 | 503 `{"error":"unavailable_host"}` | — |
| events | after 滑出 Host buffer | 200 `{"resync":true}` | 客户端改查 GET |
| 路径/方法 | 其它 | 404 / 405 | — |

## 1. 范围

- 本仓库做什么：
  - shared：新消息对 `LocalTaskApiRequest`（main→host，op 联合）与 `LocalTaskApiResponse`（host→main，requestId 关联）+ zod schema。
  - desktop Main（新文件 `packages/desktop/src/main/localTaskApi.ts`）：开关文件、HTTP 监听、鉴权、传输层校验、路由（按 workspace 找拥有 Host）、requestId 转发、taskId→workspace 归属表。
  - desktop Host（新文件 `packages/desktop/src/host/localTaskApiResponder.ts`）：六个 op 的处理（调本 Host 的 `IZCodeTaskService`）、事件 ring buffer 与长轮询。
  - 接线：`main/index.ts`（创建 server + 注入路由函数）、`host/index.ts`（1 case + 1 实例 + 1 import）、`desktopHostProcess.ts`（应答回流 + Host 退出结清）、`taskRealtimeBus.ts`（新增 `findHostProcessByWorkspaceKey` 公开方法）。taskId→workspacePath 归属表在 `localTaskApi.ts` 模块内。
  - docs：`docs/local-task-api.md`（英文上游文档）。
- **不做什么**：
  - 不做权限批复 API（`permission.requested` 事件只给摘要，去 GUI 处理）。
  - 不自动打开 workspace（409 而非 GUI 打开链——A2 调查证实该链条长且时机不确定）。
  - 不主动管理非本 API 创建的任务：归属表由 create 与重锚定 2xx 回填写入；ZCode 重启后不带 workspacePath 的旧 taskId 404（带则按 FR-015 重锚定恢复接续）。
  - 不改 GUI、不改 bots、不改 Web 服务、不做远端 workspace（workspaceIdentity 非空 → 按 409 处理，本地 workspace 专用）。
  - 不做 TLS；不做 token 轮换；不做事件持久化（Host 内存 ring buffer）。
- **既有系统清单**（穷举不判断；全部已在本分支卡片登记）：

| 既有模块 / 机制 | 出处 | 本次怎么碰到 | 卡片 |
|---|---|---|---|
| `IZCodeTaskService`（createTask/sendPrompt/enqueueTaskCommand/promoteTaskCommand/stopGeneration/getTaskSnapshot/getTaskMeta/listTasks/listActiveTaskIds/renameTask/onDynamicTaskEvent/onDynamicTaskTerminalOutcome） | `packages/services/src/session/zcodeTaskService.ts:185-780` | Host responder 业务面（r5 起不含 enqueue/promote） | `cards/ZCode/desktop-host-ipc.md`（本次扩为 host 任务面）+ 新域卡 |
| 无界面派发先例（createTask+sendPrompt 参数模式） | `packages/desktop/src/host/index.ts:742-755, 777-804` | 照抄参数形态（deferPersistenceUntilFirstPrompt、clientMode desktop-continuous） | 同上 |
| running 判定（listActiveTaskIds） | `zcodeTaskService.ts:448-456`；使用先例 `host/index.ts:700-705` | get 五态（send op r5 起不再分流，steer 空闲判定除外） | 同上 |
| waiting 判定（runtime 快照字段） | `packages/shared/src/zcode-task-types-core.ts`（ZCodeSessionRuntimeSnapshot 的 pendingPermissions/pendingElicitations，约 1013-1047 行） | get 五态 | 同上 |
| 流事件类型判别（task_run_started/task_complete/task_error/permission_request…） | `zcode-task-types-core.ts:456-988` | 事件投影 | 同上 |
| main→host requestId postMessage 模式 | `resourceManagerHostSampling.ts`（先例）；v1 已实现过同型 dispatcher（本分支 75f60bd3 回退前） | dispatcher 重建 | 同上 |
| workspace→Host 路由（taskRealtimeBus hosts 注册表：hostId→{windowId, child, workspaceKeys}） | `taskRealtimeBus.ts:39-47, 146-183`；workspaceKey 语义 `task-realtime-core.ts:84-89` | Main 路由函数的数据源 | 同上 |
| windowWorkspaceMap（renderer SyncWindowTabs 上报，win.id→本地 workspace 集合） | `main/index.ts:658`；写入 `desktopMainIpcPlatform.ts:276-285` | 路由的间接上游（bus 的 workspaceKeys 源） | 同上 |
| prepareAppQuit / whenReady 接线点 | `main/index.ts`（v1 已用同点，已回退） | server 生命周期 | 同上 |
| architecture unmanaged-new-file 例外机制 | `architecture-policy.yaml:749`（exceptions） | 两个新 src 文件登记 | — |
| `IModelSelectionService.getView()`（模型候选单一来源） | `packages/services/src/model-provider/providerFacadeServices.ts:95-98`；View 类型 `packages/provider/src/facades.ts:184-204` | /api/models 投影（FR-018） | 新增（本轮） |
| GUI 新建对话模型菜单分组与思考档位投影 | `packages/ui/src/lib/modelSelectionGroups.ts:33-78`；`packages/ui/src/lib/modelThoughtOption.ts:5-34`（optionSpecs.reasoningLevel.values） | /api/models 与 GUI 同源的证据链 | 新增（本轮） |
| 主进程打开工作区共用函数 handleOpenWorkspacePath | `packages/desktop/src/main/desktopOAuthDeepLink.ts:188-239`（含 isValidLocalWorkspaceDirectory :120-129、pending 缓存投递 :462-491）；deep link 入口 `main/index.ts:1996-2020`；--open-workspace/second-instance `packages/desktop/src/main/desktopSecondInstanceDeepLink.ts:69`；renderer 加标签 `packages/ui/src/root/useRootPlatformEffects.ts:203-215` | workspace 自动打开（FR-020）注入实现 | 新增（r7 轮） |
| `setModel`（任务换模型）与 GUI 运行中语义 | `packages/services/src/session/zcodeTaskService.ts:599-604`；adapter `zcodeTaskServiceAdapter.ts:2859-2873`；GUI 仅 Highspeed 锁（`SessionPane.tsx:4408-4415` toast「加速期间模型已锁定」） | POST /:id/model（FR-019） | 新增（本轮） |

### 1.1 功能需求（MUST 编号）

| 编号 | 需求 |
|---|---|
| FR-001 | 开关文件 `<getAppConfigDir()>/local-task-api.json`：`{"enabled":true,"port":<1-65535>,"token":"<≥32 字符>"}`；缺失/损坏（warn）/enabled≠true/token<32 → 不监听；启动读一次；ZCode 只读。 |
| FR-002 | 监听只绑 `127.0.0.1:<port>`，全应用唯一（Main）；端口占用 warn 不崩；prepareAppQuit 关闭。 |
| FR-003 | `GET /health` → 200 `{"ok":true,"api":"zcode-local-task-api","version":2,"zcodeVersion":"<app version>"}`，无鉴权。 |
| FR-004 | 除 /health 外：Host 头白名单（403，读 body 前）→ Bearer token 常量时间比较（401）→ POST Content-Type 必须含 application/json（415）→ body ≤16 MiB（413）；无 CORS 头；其它方法 405、路径 404。 |
| FR-005 | `POST /api/tasks` `{workspacePath, prompt, mode?, title?, clientRequestId?}` → 201 `{taskId}`：Host 侧 createTask（deferPersistenceUntilFirstPrompt）→ 订阅事件（失败不致命）→ sendPrompt 首条（失败仍 201 带 `warning:"first_prompt_failed"` 并跳过 rename）→ title 非空且首条成功则此刻 renameTask；workspace 无拥有 Host → 409 `workspace_not_open`。`mode` 双层枚举白名单（Main body 校验 + shared schema，对齐 `ZCodeTaskMode` 全集，非法 400）。 |
| FR-006 | `POST /api/tasks/:id/messages` `{text, delivery?:auto\|queue\|steer, clientRequestId?, workspacePath?}` → 202 `{delivery:"sent"\|"queued"\|"steered", commandId}`（空闲任务收到 steer 时按实际去向应答 `sent`；clientRequestId 与 create 同语义：key=task+id、10 分钟去重、in-flight 共享应答、命中回首次应答、失败不缓存）：全部走 `sendPrompt`（底层 v4 sendText）——auto 不带 requestedDelivery（CLI 按会话 followupMode 裁决，= GUI 运行中默认发送）；queue 带 `"queue"`；steer 带 `"guide"`（CLI 即时引导注入，结果经事件流回报 `input.steered`/`steer.injected`/`steer.fellBack`）；taskId 未知 → 404。 |
| FR-007 | `POST /api/tasks/:id/stop` → 202（stopGeneration）；未知 → 404。 |
| FR-008 | `GET /api/tasks/:id` → `{taskId, workspacePath, title, status, turnCount, lastAssistantText, updatedAt}`；五态映射见 §4；快照不存在 → 404。 |
| FR-009 | `GET /api/tasks/:id/events?after=<seq>&waitMs=<0..30000>` → `{events:[{seq,type,at,…}], nextSeq}`；长轮询至 waitMs；无历史可回放 → `{resync:true}`；事件 9 类见 §2。 |
| FR-010 | `GET /api/tasks?workspacePath=...` → `{tasks:[{taskId,title,status,updatedAt}]}`（listTasks 精简投影）。 |
| FR-011 | 多窗口路由：按 workspaceKey（= 本地 workspacePath）经 taskRealtimeBus hosts 注册表找拥有 Host；找不到 → 409；Main 维护 taskId→workspacePath 归属表（仅本 API 创建的任务）。 |
| FR-012 | Host responder 用真实 `IZCodeTaskService` 类型（`Pick` 面）；上游签名变化编译失败。 |
| FR-013 | 日志：生命周期 info + 拒绝原因计数（401/403/415/413/409/503 各计数）；请求体/prompt/token 不落日志。 |
| FR-014 | 上游文档 `docs/local-task-api.md`（英文）+ dw 产物同步（卡片、CHANGELOG、决策记录）。 |
| FR-015 | 带 :taskId 的端点（messages/stop/get/events）接受可选 workspacePath（GET 用 query `?workspacePath=`，POST 放 body）：归属表命中照旧；未命中且带了 workspacePath → 按该工作区路由，Host 用 `getTaskMeta({taskId, workspacePath})`（`zcodeTaskService.ts:526-530`，null 即不属于/不存在 → 404）校验，应答 2xx 时 Main 回填归属表；未命中且未带 → 404。events 缓冲重启后为空是预期（空事件 + 当前 nextSeq，客户端用 GET task 取状态）。 |
| FR-016 | create 可选 `clientRequestId`（1..200 字符）：Main 维护 10 分钟去重窗口——命中已完成的记 direct 返回同 `{taskId}`；**in-flight 期间并发同 id 请求 await 同一应答**（同 taskId 或同错误，不重复派发）；失败不缓存；并发数量 ZCode 侧不限流（调用方自限，见文档 Limitations）。 |
| FR-017 | create 可选 `modelSelection`（strict schema：providerId/modelId 非空串、options 只许 reasoningLevel 非空串、多余键拒绝）：Main 先 safeParse 失败即 400（防 Host 侧 shared 拒绝导致 300s 悬挂，与 mode 同理由），合法值原样透传 `createTask` 的 `modelSelection`（deprecated 的 model/thoughtLevel 不用）。 |
| FR-018 | `GET /api/models?workspacePath=`（鉴权同其它端点，workspace 必须已打开否则 409）：Host 经 `IModelSelectionService.getView()`（GUI 新建对话同源；分组先例 `ui/src/lib/modelSelectionGroups.ts:33`、思考档位 `ui/src/lib/modelThoughtOption.ts:16`、默认 automation 先例 `host/automationModelSelection.ts:23`）投影精简结构：`{providers:[{providerId, displayName, models:[{modelId, displayName, thoughtLevels: optionSpecs.reasoningLevel.values ?? [], isDefault}]}], preferred?}`；服务缺失 503。 |
| FR-019 | `POST /api/tasks/:id/model` body `{modelSelection（必填，同 FR-017 strict 校验 400）, workspacePath?, clientRequestId?}`：归属校验（getTaskMeta null → 404）→ `setModel({taskId, traceId: 新 uuid, modelSelection})` → 200 `{ok:true}`；运行中允许换模型（GUI 语义，见偏离 #19）；clientRequestId 幂等 key=`model\0<taskId>\0<id>` 与 send 命名空间隔离。 |
| FR-020 | workspace 未打开时自动打开（用户需求 2026-10-28）：dispatcher 解析不到 Host 且注入了 openWorkspace 时，经 Main 注入实现走与 deep link/--open-workspace/Finder 同一条 `handleOpenWorkspacePath` 链路（desktopOAuthDeepLink.ts:188-239；当前窗口加 workspace 标签，不自定义窗口策略），再有界轮询等待 Host 注册（默认 30s/250ms，deps 可注入）；路径非本地目录/网络路径 → 400 `workspace_path_invalid`；进程级拦截（强制升级）→ 409 `workspace_open_blocked`；超时 → 409 `workspace_open_timeout`；同 workspace 并发共享一次打开+等待（in-flight 去重）；未注入 openWorkspace（单测环境）维持 409 `workspace_not_open`。只对本地路径生效。 |

## 2. 数据模型 / 数据结构

- **开关文件** zod：`z.object({enabled: z.boolean().optional(), port: z.number().int().min(1).max(65535).optional(), token: z.string().min(32).optional()}).strict()`；监听条件 `enabled===true && port 合法 && token≥32`。
- **main→host 消息** `LocalTaskApiRequest`：
  ```ts
  { type: "local-task-api-request", requestId: string, op:
    | { kind: "create"; workspacePath: string; prompt: string; mode?: string; title?: string }
    | { kind: "send"; workspacePath: string; taskId: string; text: string; delivery: "auto"|"queue"|"steer" }
    | { kind: "stop"; workspacePath: string; taskId: string }
    | { kind: "get"; workspacePath: string; taskId: string }
    | { kind: "events"; workspacePath: string; taskId: string; after: number; waitMs: number }
    | { kind: "list"; workspacePath: string }
    | { kind: "setModel"; workspacePath: string; taskId: string; modelSelection: ModelSelection }
    | { kind: "listModels"; workspacePath: string } }
  ```
  （workspacePath 由 Main 从归属表/请求解析后填入——Host 不重复解析路由。）
- **host→main 应答** `LocalTaskApiResponse`：
  ```ts
  { type: "local-task-api-response", requestId: string,
    ok: boolean,          // false → Main 回 503
    status: number,       // 200/201/202/404/409
    body: unknown }
  ```
- **HTTP 事件条目**（Host buffer 内同构）：
  ```ts
  type LocalTaskApiEvent =
    | { seq: number; type: "turn.started"; at: number; turnId: string }
    | { seq: number; type: "assistant.message"; at: number; text: string }
    | { seq: number; type: "turn.completed"; at: number; text: string }
    | { seq: number; type: "turn.failed"; at: number; error: string }
    | { seq: number; type: "permission.requested"; at: number; summary: string }
    | { seq: number; type: "input.queued"; at: number; commandId: string }
    | { seq: number; type: "input.steered"; at: number; commandId: string }
  | { seq: number; type: "steer.injected"; at: number }
  | { seq: number; type: "steer.fellBack"; at: number; error: string };
  ```
  seq 每 task 从 1 单调；ring buffer 每 task 上限 500 条。

## 3. 接口契约（HTTP 面）

| 接口 | 入参 | 出参 | 鉴权 |
|---|---|---|---|
| GET /health | — | 200 见 FR-003 | 无 |
| POST /api/tasks | `{workspacePath, prompt, mode?, title?, modelSelection?, clientRequestId?}` | 201 `{taskId}` / 400（mode/modelSelection/clientRequestId 非法） / 409 | Bearer |
| POST /api/tasks/:id/messages | `{text, delivery?, workspacePath?}` | 202 `{delivery, commandId?}` / 404 / 409 | Bearer |
| POST /api/tasks/:id/stop | body 可选 `{workspacePath?}` | 202 `{ok:true}` / 404 / 409 | Bearer |
| GET /api/tasks/:id | query 可选 `?workspacePath=` | 200 任务摘要 / 404 / 409 | Bearer |
| GET /api/tasks/:id/events | `after`, `waitMs`, query 可选 `?workspacePath=` | 200 `{events,nextSeq}` 或 `{resync:true}` / 404 / 409 | Bearer |
| GET /api/tasks?workspacePath= | query | 200 `{tasks:[…]}` / 409 | Bearer |
| GET /api/models?workspacePath= | query（workspacePath 必填） | 200 `{providers:[…], preferred?}` / 400 / 409 | Bearer |
| POST /api/tasks/:id/model | `{modelSelection, workspacePath?, clientRequestId?}` | 200 `{ok:true}` / 400 / 404 / 409 | Bearer |

> `workspacePath`（可选）的语义（FR-015）：归属表未命中时的重新锚定入口——Host 用 `getTaskMeta` 核实任务确属该工作区，2xx 应答即回填归属表，之后的请求可省略。

**错误码**（HTTP + `error` 字段，lowercase_underscore）：`unauthorized`（401）、`host_header_forbidden`（403）、`unsupported_media_type`（415）、`payload_too_large`（413）、`workspace_not_open`（409）、`workspace_path_invalid`（400，自动打开判定路径非本地目录）、`workspace_open_blocked`（409，进程级拦截如强制升级）、`workspace_open_timeout`（409，打开后 30s 内 Host 未注册）、`task_not_found`（404）、`unavailable_host`（503）、`not_found`/`method_not_allowed`、`bad_request`（400，body/query 参数校验失败，先于 taskId 归属判定）、`internal_error`（500，处理兜底）。

## 4. 核心逻辑 / 流程

1. **五态投影**（get op，按序判定）：
   ```
   snapshot = getTaskSnapshot({taskId, workspacePath}); null → 404
   runtime.pendingPermissions?.length > 0 → "waiting_permission"
   runtime.pendingElicitations?.length > 0 → "waiting_input"
   (await listActiveTaskIds({workspacePath})).includes(taskId) → "running"
   snapshot.meta.status === "error" → "error"
   else → "idle"
   ```
   `lastAssistantText` = snapshot.messages 反向首条 `role==="assistant"` 的 `content`（无则 `""`）；`turnCount` = messages 里 assistant 条数（meta 无原生字段，见 §12 偏离）；`updatedAt` = meta.updatedAt；`title` = meta.title。
2. **事件投影**（Host responder，订阅 `onDynamicTaskEvent({workspacePath, taskId})` 与 `onDynamicTaskTerminalOutcome(taskId)`）：
   ```
   task_run_started        → {type:"turn.started", turnId}
   permission_request      → {type:"permission.requested", summary: kind+title/description 摘要}
   task_complete           → 读 snapshot 最后 assistant 文本 T：先发 {assistant.message, text:T} 再发 {turn.completed, text:T}
   task_error              → {turn.failed, error}（与 failed 终态 1s 内去重只发一次，见 §12 偏离）
   terminalOutcome stopped → {turn.completed, text:""}（契约无 stopped 类型，见 §12 偏离）
   turn_steer_queued        → {type:"input.steered", commandId:pendingInputId}（steer 受理不自产，以 CLI 事件为准）
   turn_steer_status drained → {type:"steer.injected"}；discarded/rejected → {type:"steer.fellBack", error:reason}
   本 API 自身 auto/queue 受理成功 → {input.queued, commandId}（CLI 无 queue 专属流事件，受理即事实）
   终态到达 → 10 分钟后整体释放该任务的流订阅与事件缓冲（buffers 删除；后续 events 查询懒重建空缓冲，长驻进程不累积陈旧任务状态）
   ```
3. **create op**：`createTask({workspacePath, ...(mode?{mode}), deferPersistenceUntilFirstPrompt:true})`（mode 经 Main 与 shared 双层枚举白名单，对齐 `ZCodeTaskMode` 全集；`yolo` 即 GUI「完全访问」档）→ 建订阅与 buffer（失败不致命）→ `sendPrompt({taskId, traceId: result.traceId, content: prompt, clientMode:"desktop-continuous"})` → **title 非空则此刻 `renameTask`**（defer 模式下 session 随首条 prompt 落盘，此前 renameSession 报 `Session not found after write`——真机日志 2026-10-28 实锤）→ Main 记归属表 → 201。sendPrompt 失败不整体 503：仍回 `201 {taskId, warning:"first_prompt_failed"}`（副作用可见可接续，错误只进日志；此时跳过 rename）。
4. **send op**（与 GUI 同一条链路：`sendPrompt` 底层即 v4 `sendText`，`zcodeTaskServiceAdapter.ts:457-477`，`requestedDelivery` 字段 `command.ts:101`）：前置 `getTaskMeta` 归属校验（重锚定语义，见第 7 条）→ `sendPrompt({taskId, traceId: 新 uuid, content, clientMode:"desktop-continuous", requestedDelivery?})`：
   - `auto`：不带 requestedDelivery——CLI 按会话 followupMode 裁决（GUI 运行中默认发送行为，默认 queue、可设 guide，`followupModeSettings.ts:8`）；应答 `{delivery:"sent", commandId}`，受理自产 `input.queued` 事件。
   - `queue`：`requestedDelivery:"queue"` → `{delivery:"queued", commandId}`，自产 `input.queued`。
   - `steer`：`requestedDelivery:"guide"`——CLI 即时引导注入（steering→guided/fellBack 状态机，`input-intent.ts` conversationInputSteerSchema）→ `{delivery:"steered", commandId}`；受理**不自产**事件，由 `turn_steer_queued` 流事件投影 `input.steered{commandId:pendingInputId}`；CLI 权威结果 `turn_steer_status` 投影 `steer.injected`（drained，已注入）或 `steer.fellBack{error}`（discarded/rejected，降级/被拒——GUI 的 fellBack 语义如实回报）。
5. **events 长轮询**：buffer 命中 `seq>after` 立即返回；`after < oldestSeq-1`（且 after>0）→ `{resync:true}`；否则挂 waiter 至 waitMs 或新事件（waiter 用 notifier Promise，Host 不落盘）。
6. **Main 路由**：`resolveHostByWorkspace(path)` 遍历 taskRealtimeBus hosts 注册表的 `workspaceKeys`（key = workspacePath，本地 workspace identity 为空）取 `child`（utilityProcess 直接可 postMessage）；无 → **自动打开**（FR-020，r7 轮起）：注入的 openWorkspace（main/index.ts 实现走 `handleOpenWorkspacePath` + 强制升级 blocked 判定 + `isValidLocalWorkspaceDirectory` invalid 判定；无窗口时 ensurePrimaryWindow）→ 轮询 resolveHost 至 30s → 命中继续 dispatch；invalid/blocked/timeout 按错误码应答。未注入（单测）→ 409 workspace_not_open。dispatcher 复用 v1 形态（requestId + pending Map + 300s 兜底——events 的 waitMs≤30s 远小于兜底）。
7. **taskId 重锚定（FR-015）**：Main 的 `resolveTaskWorkspace`——归属表命中用表值；未命中且请求带非空 workspacePath 用该值路由，Host 在 send/stop/events op 前置 `getTaskMeta({taskId, workspacePath})` 校验（null → 404，不调任何写操作；get op 的 getTaskSnapshot null 同效），Main 收到 2xx 应答且该请求未走表时回填 `taskWorkspaceByTaskId`。重启后首个请求带 workspacePath 即恢复接续（事件缓冲为空，GET task 可取全量状态）。
7. **鉴权**：`sha256(configToken)` vs `sha256(headerToken)` 后 `crypto.timingSafeEqual`。
8. **listModels op**（FR-018）：Host `getOptional(IModelSelectionService)`（本地容器装配 `services/src/node.ts:2984`；缺失 → 503）→ `getView()`（模型候选即 `view.providers[].models[]`，GUI 分组先例只做展示不改变候选集）→ 投影：每模型 `thoughtLevels = config.optionSpecs?.reasoningLevel?.values ?? []`（GUI 投影先例 `resolveModelThoughtOption`，缺失/空 → 无档位）、`isDefault` 按顶层 `preferredSelection` 的 providerId+modelId 命中、`displayName` 回落 providerId/modelId；顶层 `preferred` 原样透传（可直接作为 create 的 modelSelection）。不做 GUI 的 selectedProvider 菜单过滤（偏离 #18）。
9. **setModel op**（FR-019）：getTaskMeta 归属校验（null → 404，与 send/stop/events 同模式）→ `setModel({taskId, traceId: 新 uuid, modelSelection})`（adapter 直发 agent runtime，`zcodeTaskServiceAdapter.ts:2859-2873`）→ 200 `{ok:true}`（返回的 configOptions 不透出）。运行中不禁止（GUI 语义，偏离 #19）。

**设计自检**：新消息对（跨进程必需，FR-011/012）；Host 事件 buffer（Main 不承载业务状态——AGENTS.md；FR-009）；Main 归属表（taskId 无 workspace 反查接口，HTTP URL 又只有 taskId——FR-011）；409 而非自动打开（A2：自动打开需 createWindow+renderer 开 tab+等上报，时机不确定；409 查表即答）。**备选方案**：事件 buffer 放 Main（否——业务状态进 Main 违反仓库架构）；按 taskId 广播全 Host 解析 workspace（否——无接口支撑且时序不定）。

## 5. 错误处理 / 降级 / 失败模型

| 失败分类 | 恢复行为 | 重启后存活性 |
|---|---|---|
| 开关文件损坏/非法 | warn 不监听；改文件重启生效 | 不跨重启 |
| 端口占用 | warn 不监听，应用正常 | 同上 |
| 无 Host / Host 死 / 应答超时 | 503 unavailable_host；Host 退出时立即结清其在飞请求（desktopHostProcess exit 钩子），兜底超时 300s | — |
| Host responder 抛错 | ok:false → 503（出站固定文案，原始错误只进日志） | — |
| workspace 归属 Host 消失（窗口关闭） | 409 workspace_not_open（重开窗口即恢复） | 归属表进程内存，重启丢（旧 taskId → 404） |
| buffer 溢出 | resync:true，客户端查 GET | buffer 进程内存 |

## 6. 安全 / 鉴权 / 配置 / 不变量

- 信任边界：loopback + Host 头 + Bearer 三层；token 只进内存比较（sha256 摘要比较），不落日志；请求体（prompt/text）不落日志。
- 开关文件由写入方（用户/桥接 setup）负责 0600；ZCode 只读。
- **安全不变量**：
  ```
  Invariant 1: 监听只绑 127.0.0.1（listen 固定 host 参数）
  Invariant 2: 同一应用进程至多一个 task API server（whenReady 单次创建）
  Invariant 3: /health 之外所有处理在 Host 头与 Bearer 双校验通过后才开始
  Invariant 4: token 比较必须常量时间（sha256+timingSafeEqual），无短路字符串比较路径
  ```

## 7. 可观测性

- `[local-task-api]` 前缀；info：`listening on 127.0.0.1:<port>`、`created task=<taskId>`、`duplicate create request=<clientRequestId> task=<taskId>`；warn：config invalid、listen failed、dispatch failed（requestId+reason，不含路径/内容）、host exited settled n、rejected <reason> count=<n>（每次拒绝一行）、request handler error、开关文件 group/other 可读提醒、create 部分失败的原始错误（Host log）。
- 不记录：prompt/text/title 内容、token、body、workspacePath。

## 8. 兼容性 / 迁移

### 8.1 兼容取舍决策（拍板：上级任务书 2026-10-28）

| 被改变的既有行为 | 谁在依赖它 | 决定 | 确认时间 |
|---|---|---|---|
| v1 webhook 入站全部改动 | 无人（未交付） | 全部回退（75f60bd3），不留半成品 | 2026-10-28 |
| 其余 | — | 纯新增能力，无其它既有行为变化 | 2026-10-28 |

### 8.2 替换清单

| 被取代物 | 类型 | 取代者 | 处置 |
|---|---|---|---|
| v1 webhook 入站（消息对/应答器/Main ingress/UI/文档/架构例外） | 代码段 | 本 spec v2 | 已随 75f60bd3 回退到 origin/main 原样 |

### 8.3 数据迁移

无（v1 未持久化任何数据；v2 归属表进程内存）。

## 9.（不含 AI 推理面变更——任务仍由既有 Agent 运行时执行，跳过）

## 10.（状态机：任务状态由既有 sessions-index 权威管理，本 API 只投影，不引入新状态机）

## 11. 完成定义

| 编号 | 验收项 | 满足 |
|---|---|---|
| AC-001 | §0 齐全 | — |
| AC-002 | Main 契约测试（真实监听随机端口）：health 形状、403/401/415/413、404/405、无 CORS、开关三态、端口占用、Bearer 正确通过、token<32 不监听 | FR-001~FR-004 |
| AC-003 | Host responder 单测（mock IZCodeTaskService，类型绑定 Pick 面）：create 参数形态（deferPersistenceUntilFirstPrompt、clientMode）、send 三 delivery（requestedDelivery 断言：auto 无/queue/steer=guide）、steer 流事件投影（input.steered/steer.injected/steer.fellBack）、rename 在 sendPrompt 后、stop、五态投影、events 立即返回/长轮询唤醒/resync、input.queued 事件 | FR-005~FR-010, FR-012 |
| AC-004 | Main 路由单测：归属表 miss→404、无 Host→409/503、dispatcher requestId 回流/超时 | FR-011 |
| AC-005 | 上游文档 + dw 产物（卡片/CHANGELOG/决策记录/v1 spec 转 superseded） | FR-014 |
| AC-006 | typecheck / lint / 相关单测 / architecture:check --changed 真跑记录（2026-10-28 实测：typecheck 0 错；lint 0 errors / 96 条存量 warnings（本次文件零命中）；Host responder 16 用例 + Main 17 用例共 33 例全绿；architecture:check --changed OK——两新 src 文件经 unmanaged-new-file 例外登记；ctx lint-cards 0 违规。评审修复轮后实测（2026-10-28 第二轮）：typecheck 0 错；Main 28 + Host 24 共 52 例全绿；lint 0 errors / 96 条存量 warnings 零命中；architecture:check --changed 0 违规；lint-cards 0 违规。第三轮修复后实测（2026-10-28 第三轮）：typecheck 0 错；Main 30 + Host 28 共 58 例全绿；lint 0 errors / 96 条存量 warnings 零命中；architecture:check --changed 0 违规；lint-cards 0 违规。真机反馈修复后实测（2026-10-28 真机轮）：typecheck 0 错；Host 28 + Main 30 共 58 例全绿。第五轮修复后实测（2026-10-28 第五轮）：typecheck 0 错；Main 35 + Host 31 共 66 例全绿；lint 0 errors（96 条存量 warnings）；architecture:check 0 违规；lint-cards 0 违规；clientRequestId 幂等抽独立模块 localTaskApiClientRequestId.ts（Main 文件回到 800 行限内）。模型选择轮实测（2026-10-28 第六轮）：typecheck 0 错；Main 44 + Host 37 共 81 例全绿；lint 0 errors / 96 条存量 warnings；architecture:check 0 违规（新拆 localTaskApiHttpUtil.ts / localTaskApiModelRoutes.ts 登记例外）；lint-cards 0 违规。workspace 自动打开轮实测（2026-10-28 r7 轮）：typecheck 0 错；Main 51 + Host 37 共 88 例全绿；lint 0 errors；architecture:check 0 违规（localTaskApiWorkspaceOpener.ts 登记例外）；lint-cards 0 违规） | — |
| AC-007 | 日志断言：拒绝路径计数、无 prompt 内容 | FR-013 |
| AC-008 | 重锚定测试：重启（表空）后带 workspacePath 续聊成功且回填（后续请求可省略）；带错 workspacePath 404 透传且不回填；不带 404；Host 侧 send/stop/events 对不属于该 workspace 的任务 404 且不触发写操作 | FR-015 |
| AC-009 | 评审轮补充测试：create 部分失败（sendPrompt reject）仍 201 带 warning 且 taskId 可用；订阅建立失败不影响 201；auto/queue 受理后 buffer 即有 input.queued；waiting_input 五态分支；mode 非法 400；clientRequestId 命中返回同 taskId 不再派发；Host 退出结清在飞请求；终态后流订阅释放；op 异常出站固定文案 + 日志留痕 | FR-005/FR-013/FR-016 及评审项 |
| AC-010 | 第三轮补充测试：长轮询唤醒只含 after 之后的新事件；懒重建后 after>0 回 `{resync:true}`、after=0 得空事件；rename 失败 201 带 `rename_failed`（与 first_prompt_failed 优先级）；clientRequestId 并发同 id 只派发一次且两请求同 taskId、失败不缓存。第五轮补充：CLI 真实形状下 `input.steered.commandId === 202 应答 commandId`（inputId 关联）；空闲任务 steer 应答 sent；messages clientRequestId 同 create 语义（命中回首次应答、in-flight 共享、失败不缓存） | r3-37 #3、r3-39 #1/#2/#3/#4 |
| AC-011 | 模型选择测试：create modelSelection 非法三形状 400 不 dispatch / 合法透传；GET /api/models 403/401/400/409/200 透传与 op 深等；POST /:id/model 400 先于 404、归属 miss 404、重锚定透传、幂等代答与失败不缓存；responder create 透传、listModels 投影深等（displayName 回落/thoughtLevels 缺省/isDefault/preferred）、服务缺失 503、setModel 404 前置/成功参数（uuid traceId）/抛错 503 固定文案 | FR-017/FR-018/FR-019 |
| AC-012 | workspace 自动打开测试：未注入 openWorkspace 回归 409；invalid 400 不触达 Host 且 openWorkspace 恰一次；blocked 409；opened+注册及时派发成功（op 形状断言）；opened+超时 409（warn 留痕）；并发同 workspace openWorkspace 恰一次且两请求都派发；openWorkspace 抛错 503 固定文案 | FR-020 |

**覆盖自查**：FR-001→AC-002；FR-002→AC-002；FR-003→AC-002；FR-004→AC-002；FR-005→AC-003/AC-009；FR-006→AC-003/AC-010；FR-007→AC-003；FR-008→AC-003；FR-009→AC-003/AC-010；FR-010→AC-003；FR-011→AC-004；FR-012→AC-003；FR-013→AC-007/AC-009；FR-014→AC-005；FR-015→AC-008；FR-016→AC-009/AC-010；FR-017→AC-011；FR-018→AC-011；FR-019→AC-011；FR-020→AC-012。



## 12. 契约偏离（对上级契约 v2 文本；最终总结会重复列出）

| # | 偏离 | 理由 |
|---|---|---|
| 1 | `turnCount` = snapshot.messages 中 assistant 条数 | `ZCodeTaskMeta` 无原生 turnCount 字段（zcode-task-types-core.ts:276-363） |
| 2 | `steer` = `sendPrompt` 带 `requestedDelivery:"guide"`（与 GUI 同一条 v4 sendText 链路，CLI 权威裁决注入或 fellBack 降级，结果经事件流回报）——第一版 enqueue+promote 近似经真机证实只是插队首，已废弃 | sendPrompt 底层即 v4 sendText（zcodeTaskServiceAdapter.ts:457-477、command.ts:101 requestedDelivery），加参数透传即同链路 |
| 3 | stopped 终态 → `turn.completed`（text 空） | 契约事件闭集无 stopped 类型 |
| 4 | ZCode 重启后旧 taskId 需在首个请求带 `workspacePath` 重新锚定（Host `getTaskMeta` 校验后回填归属表），不带则 404；events 缓冲重启后为空 | tasks-index 无按 taskId 反查 workspace 的服务接口；getTaskMeta 按 workspace 校验是现成原语。已按上级 2026-10-28 追加要求从「直接 404」升级为可选重锚定 |
| 5 | workspace 未打开 → **自动打开后派发**（r7 轮起，用户需求）：与 deep link/--open-workspace/Finder 同一条 `handleOpenWorkspacePath` 链路（当前窗口加标签），有界等待 Host 注册 30s；路径无效 400、进程级拦截 409 `workspace_open_blocked`、超时 409 `workspace_open_timeout`；同 workspace 并发去重。未注入 openWorkspace 的部署（单测）维持 409 `workspace_not_open` | 原「自动打开链长时机不定」经用户需求推翻；有界等待+去重控制时机与副作用 |
| 6 | workspaceIdentity 非空（远端 workspace）→ 409 | v2 只做本地 workspace；路由表 workspaceKeys 只含本地 |
| 7 | 检查顺序：Host 头(403) → Bearer(401) → Content-Type(415) → 大小(413)；路径级 404/405 在鉴权前返回；POST body 参数校验（400 bad_request）先于 taskId 归属判定（404） | DNS rebinding 防护先于鉴权；契约未定顺序 |
| 8 | `input.queued`（auto/queue 受理）由 API 自产；`input.steered` 由 CLI `turn_steer_queued` 流事件投影（commandId=pendingInputId）；CLI 权威结果另投影 `steer.injected`（drained）/`steer.fellBack{error}`（discarded/rejected） | queue 无专属流事件、受理即事实；steer 有 CLI 权威事件则以事件为准 |
| 9 | 事件字段形状：`turn.started{turnId}`、`assistant.message{text}`、`turn.completed{text}`、`turn.failed{error}`、`permission.requested{summary}`、`input.queued{commandId}`（auto/queue 受理自产）、`input.steered{commandId}`（CLI `turn_steer_queued` 投影，commandId=事件 inputId=envelope.commandId=202 应答 commandId；该类事件也可能来自 GUI 侧对同一任务的引导，消费方按 commandId 对账）、`steer.injected{}`（`turn_steer_status` drained：已注入当前轮）、`steer.fellBack{error}`（discarded/rejected：引导降级/被拒）；seq 每 task 从 1 单调（终态释放后懒重建从 1 重计，`after>0` 的旧水位返回 `{resync:true}`）；缓冲每任务 500 条、溢出 `{resync:true}`；长轮询唤醒按各客户端 `after` 过滤只发新事件；`task_error` 流事件与 failed 终态 1s 内去重只发一次；任务终态后 10 分钟整体释放订阅与缓冲（懒重建） | 契约正文未逐一点名字段名；去重防重复 failed；修剪防长驻进程累积 |
| 10 | POST `/stop` 空 body 放行（无 Content-Type 也可）；`?workspacePath=`/body 空字符串视为未提供 | 传输层宽容语义已在文档写明 |
| 11 | create 的 `mode` 经双层枚举白名单（对齐 `ZCodeTaskMode` 全集），非法值 400；上游文档列取值与权限含义（bypass 类档位会跳过权限闸门，含明确警示） | 评审拍板①；防 shared schema 拒绝导致的 300s 悬挂与免审批档位静默可达 |
| 12 | create 接受可选 `clientRequestId`（1..200 字符）：Main 维护 10 分钟去重窗口，命中直接返回同一 `{taskId}` 不再派发 | 评审拍板②；create 有真实 agent 运行成本，HTTP 超时盲重试不应重复建任务 |
| 13 | create 部分失败仍回 `201 {taskId, warning}`：`first_prompt_failed`（首条 prompt 失败，此时跳过 rename）优先于 `rename_failed`（sendPrompt 后 rename 失败）；订阅建立失败不影响 201。rename 在 sendPrompt 之后执行——defer 模式下 session 随首条 prompt 落盘（真机日志：此前 renameSession 报 Session not found after write） | 副作用可见可接续；title 是对账锚点 |
| 14 | Host 退出时 Main 立即结清该 Host 的在飞请求（503），不等 300s 兜底；并发数量 ZCode 侧不限流（文档写明由调用方自限）；开关文件 group/other 可读仅 warn 不拒启 | 评审拍板③④与 r2-29 #3 |
| 15 | （已并入 #2/#8——enqueue+promote 近似随真机轮废弃，promote_failed 分支不复存在） | r3-39 #1 的场景随路径消失 |
| 16 | clientRequestId 并发同 id：in-flight 期间后续请求 await 同一应答（同 taskId 或同错误），不重复派发；失败不缓存（后续请求可重试） | 评审 r3-39 #3：HTTP 超时早于 create 应答时重试落进 in-flight 窗口，占位共享才能保证幂等 |
| 17 | create 的 `modelSelection` 用 shared strict schema 双层校验（Main safeParse 先 400 + Host 侧 schema），形状=ModelSelection：`{providerId, modelId, options?{reasoningLevel}}`，多余键/空串拒绝；deprecated 的 model/thoughtLevel 不暴露 | 上级 2026-10-28 追加需求；strict 拒绝发生在 Host 侧会悬挂 300s，Main 先 400 |
| 18 | /api/models 返回精简投影：`{providers:[{providerId, displayName(回落 providerId), models:[{modelId, displayName=modelId, thoughtLevels(缺失→[]), isDefault}]}], preferred?}`；不做 GUI 的 selectedProvider 菜单过滤；仍按 workspace 路由到拥有 Host（getView 本身不吃 workspace，但路由/409/鉴权语义与其余端点一致） | 上级要求复用 GUI 同源（IModelSelectionService.getView + buildRegistryModelSelectGroups/resolveModelThoughtOption 投影链）不自行拼装；view.providers 即 Registry 执行目录 |
| 19 | POST /:id/model 运行中**允许**换模型（不加 409）：GUI 普通运行中不锁模型（SessionPane 仅 Highspeed 卡激活时锁并 toast）；Highspeed 是 UI 运行态 Host 侧不可见，agent 侧拒绝时表现为 503 unavailable_host；setModel 返回的 configOptions 不透出 | 上级条件句「GUI 若禁止则 409」经调查不成立；configOptions 是 GUI 投影面，API 不需要 |
| 20 | /:id/model 的 clientRequestId 幂等为独立 model 命名空间（key=`model\0<taskId>\0<id>`），与 send/create 均隔离 | 同一 clientRequestId 先用于 messages 再用于换模型不应互相代答 |

## 13. 过稿记录（MUST）

- 2026-10-28 ｜ 拍板人显式跳过 ｜ 上级任务书延续 v1 的跳过声明（方案变更指令即拍板）。

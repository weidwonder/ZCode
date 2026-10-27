---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-28'
authority_refs:
  - '本机任务 API 端点契约（health/auth/tasks/messages/stop/get/events/list，见 docs/local-task-api.md）'
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
  - 接线：`main/index.ts`（创建 server + 注入路由函数 + 归属表）、`host/index.ts`（1 case + 1 实例 + 1 import）、`desktopHostProcess.ts`（应答回流 3 行）。
  - docs：`docs/local-task-api.md`（英文上游文档）。
- **不做什么**：
  - 不做权限批复 API（`permission.requested` 事件只给摘要，去 GUI 处理）。
  - 不自动打开 workspace（409 而非 GUI 打开链——A2 调查证实该链条长且时机不确定）。
  - 不管理「非本 API 创建的任务」：Main 归属表只在 create 时写入，ZCode 重启后旧 taskId 的 API 操作 404（桥接重新 create 即可；行为确定，见 §12 偏离）。
  - 不改 GUI、不改 bots、不改 Web 服务、不做远端 workspace（workspaceIdentity 非空 → 按 409 处理，本地 workspace 专用）。
  - 不做 TLS；不做 token 轮换；不做事件持久化（Host 内存 ring buffer）。
- **既有系统清单**（穷举不判断；全部已在本分支卡片登记）：

| 既有模块 / 机制 | 出处 | 本次怎么碰到 | 卡片 |
|---|---|---|---|
| `IZCodeTaskService`（createTask/sendPrompt/enqueueTaskCommand/promoteTaskCommand/stopGeneration/getTaskSnapshot/getTaskMeta/listTasks/listActiveTaskIds/renameTask/onDynamicTaskEvent/onDynamicTaskTerminalOutcome） | `packages/services/src/session/zcodeTaskService.ts:185-780` | Host responder 的全部业务面 | `cards/ZCode/desktop-host-ipc.md`（本次扩为 host 任务面）+ 新域卡 |
| 无界面派发先例（createTask+sendPrompt 参数模式） | `packages/desktop/src/host/index.ts:742-755, 777-804` | 照抄参数形态（deferPersistenceUntilFirstPrompt、clientMode desktop-continuous） | 同上 |
| running 判定（listActiveTaskIds） | `zcodeTaskService.ts:448-456`；使用先例 `host/index.ts:700-705` | send op 分流与 get 五态 | 同上 |
| pendingInteraction（waiting 判定） | `packages/shared/src/zcode-task-types-core.ts:268-274` | get 五态 | 同上 |
| 流事件类型判别（task_run_started/task_complete/task_error/permission_request…） | `zcode-task-types-core.ts:456-988` | 事件投影 | 同上 |
| main→host requestId postMessage 模式 | `resourceManagerHostSampling.ts`（先例）；v1 已实现过同型 dispatcher（本分支 75f60bd3 回退前） | dispatcher 重建 | 同上 |
| workspace→Host 路由（taskRealtimeBus hosts 注册表：hostId→{windowId, child, workspaceKeys}） | `taskRealtimeBus.ts:39-47, 146-183`；workspaceKey 语义 `task-realtime-core.ts:84-89` | Main 路由函数的数据源 | 同上 |
| windowWorkspaceMap（renderer SyncWindowTabs 上报，win.id→本地 workspace 集合） | `main/index.ts:658`；写入 `desktopMainIpcPlatform.ts:276-285` | 路由的间接上游（bus 的 workspaceKeys 源） | 同上 |
| prepareAppQuit / whenReady 接线点 | `main/index.ts`（v1 已用同点，已回退） | server 生命周期 | 同上 |
| architecture unmanaged-new-file 例外机制 | `architecture-policy.yaml:749`（exceptions） | 三个新文件登记 | — |

### 1.1 功能需求（MUST 编号）

| 编号 | 需求 |
|---|---|
| FR-001 | 开关文件 `<getAppConfigDir()>/local-task-api.json`：`{"enabled":true,"port":<1-65535>,"token":"<≥32 字符>"}`；缺失/损坏（warn）/enabled≠true/token<32 → 不监听；启动读一次；ZCode 只读。 |
| FR-002 | 监听只绑 `127.0.0.1:<port>`，全应用唯一（Main）；端口占用 warn 不崩；prepareAppQuit 关闭。 |
| FR-003 | `GET /health` → 200 `{"ok":true,"api":"zcode-local-task-api","version":2,"zcodeVersion":"<app version>"}`，无鉴权。 |
| FR-004 | 除 /health 外：Host 头白名单（403，读 body 前）→ Bearer token 常量时间比较（401）→ POST Content-Type 必须含 application/json（415）→ body ≤16 MiB（413）；无 CORS 头；其它方法 405、路径 404。 |
| FR-005 | `POST /api/tasks` `{workspacePath, prompt, mode?, title?}` → 201 `{taskId}`：Host 侧 createTask（deferPersistenceUntilFirstPrompt）→ 可选 renameTask(title) → 订阅事件 → sendPrompt 首条；workspace 无拥有 Host → 409 `workspace_not_open`。 |
| FR-006 | `POST /api/tasks/:id/messages` `{text, delivery?:auto\|queue\|steer}` → 202 `{delivery:"sent"\|"queued"\|"steered", commandId?}`：空闲 → sendPrompt（sent）；运行 → enqueueTaskCommand（auto/queue → queued）；steer → enqueue + promoteTaskCommand（steered）；taskId 未知 → 404。 |
| FR-007 | `POST /api/tasks/:id/stop` → 202（stopGeneration）；未知 → 404。 |
| FR-008 | `GET /api/tasks/:id` → `{taskId, workspacePath, title, status, turnCount, lastAssistantText, updatedAt}`；五态映射见 §4；快照不存在 → 404。 |
| FR-009 | `GET /api/tasks/:id/events?after=<seq>&waitMs=<0..30000>` → `{events:[{seq,type,at,…}], nextSeq}`；长轮询至 waitMs；无历史可回放 → `{resync:true}`；事件 7 类见 §2。 |
| FR-010 | `GET /api/tasks?workspacePath=...` → `{tasks:[{taskId,title,status,updatedAt}]}`（listTasks 精简投影）。 |
| FR-011 | 多窗口路由：按 workspaceKey（= 本地 workspacePath）经 taskRealtimeBus hosts 注册表找拥有 Host；找不到 → 409；Main 维护 taskId→workspacePath 归属表（仅本 API 创建的任务）。 |
| FR-012 | Host responder 用真实 `IZCodeTaskService` 类型（`Pick` 面）；上游签名变化编译失败。 |
| FR-013 | 日志：生命周期 info + 拒绝原因计数（401/403/415/413/409/503 各计数）；请求体/prompt/token 不落日志。 |
| FR-014 | 上游文档 `docs/local-task-api.md`（英文）+ dw 产物同步（卡片、CHANGELOG、决策记录）。 |

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
    | { kind: "list"; workspacePath: string } }
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
    | { seq: number; type: "input.steered"; at: number; commandId: string };
  ```
  seq 每 task 从 1 单调；ring buffer 每 task 上限 500 条。

## 3. 接口契约（HTTP 面）

| 接口 | 入参 | 出参 | 鉴权 |
|---|---|---|---|
| GET /health | — | 200 见 FR-003 | 无 |
| POST /api/tasks | `{workspacePath, prompt, mode?, title?}` | 201 `{taskId}` / 409 | Bearer |
| POST /api/tasks/:id/messages | `{text, delivery?}` | 202 `{delivery, commandId?}` / 404 / 409 | Bearer |
| POST /api/tasks/:id/stop | — | 202 `{ok:true}` / 404 / 409 | Bearer |
| GET /api/tasks/:id | — | 200 任务摘要 / 404 / 409 | Bearer |
| GET /api/tasks/:id/events | `after`, `waitMs` | 200 `{events,nextSeq}` 或 `{resync:true}` / 404 / 409 | Bearer |
| GET /api/tasks?workspacePath= | query | 200 `{tasks:[…]}` / 409 | Bearer |

**错误码**（HTTP + `error` 字段，lowercase_underscore）：`unauthorized`（401）、`host_header_forbidden`（403）、`unsupported_media_type`（415）、`payload_too_large`（413）、`workspace_not_open`（409）、`task_not_found`（404）、`unavailable_host`（503）、`not_found`/`method_not_allowed`。

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
   permission_request      → {type:"permission.requested", summary: kind+toolName 摘要}
   task_complete           → 读 snapshot 最后 assistant 文本 T：先发 {assistant.message, text:T} 再发 {turn.completed, text:T}
   task_error              → {turn.failed, error}
   terminalOutcome stopped → {turn.completed, text:""}（契约无 stopped 类型，见 §12 偏离）
   本 API 自身 queue/steer 受理成功 → {input.queued|input.steered, commandId}（不经流事件）
   ```
3. **create op**：`createTask({workspacePath, ...(mode?{mode}), deferPersistenceUntilFirstPrompt:true})` → title 非空则 `renameTask({taskId, workspacePath, title})` → 建订阅与 buffer → `sendPrompt({taskId, traceId: result.traceId, content: prompt, clientMode:"desktop-continuous"})` → Main 记归属表 → 201。异常时清理订阅。
4. **send op**：`listActiveTaskIds` 判运行；空闲 → `sendPrompt({taskId, traceId: 新 randomUUID(), content, clientMode:"desktop-continuous"})` → `{delivery:"sent"}`；运行 → `enqueueTaskCommand({workspacePath, taskId, commandId: 新 randomUUID(), traceId: 新 randomUUID(), type:"send_prompt", content})`；steer 再 `promoteTaskCommand({workspacePath, taskId, commandId, ownerRunId: 同 traceId, clientMode:"desktop-continuous"})`；成功后投 input.queued/input.steered 事件。
5. **events 长轮询**：buffer 命中 `seq>after` 立即返回；`after < oldestSeq-1`（且 after>0）→ `{resync:true}`；否则挂 waiter 至 waitMs 或新事件（waiter 用 notifier Promise，Host 不落盘）。
6. **Main 路由**：`resolveHostByWorkspace(path)` 遍历 taskRealtimeBus hosts 注册表的 `workspaceKeys`（key = workspacePath，本地 workspace identity 为空）取 `child`（utilityProcess 直接可 postMessage）；无 → 409。dispatcher 复用 v1 形态（requestId + pending Map + 300s 兜底——events 的 waitMs≤30s 远小于兜底）。
7. **鉴权**：`sha256(configToken)` vs `sha256(headerToken)` 后 `crypto.timingSafeEqual`。

**设计自检**：新消息对（跨进程必需，FR-011/012）；Host 事件 buffer（Main 不承载业务状态——AGENTS.md；FR-009）；Main 归属表（taskId 无 workspace 反查接口，HTTP URL 又只有 taskId——FR-011）；409 而非自动打开（A2：自动打开需 createWindow+renderer 开 tab+等上报，时机不确定；409 查表即答）。**备选方案**：事件 buffer 放 Main（否——业务状态进 Main 违反仓库架构）；按 taskId 广播全 Host 解析 workspace（否——无接口支撑且时序不定）。

## 5. 错误处理 / 降级 / 失败模型

| 失败分类 | 恢复行为 | 重启后存活性 |
|---|---|---|
| 开关文件损坏/非法 | warn 不监听；改文件重启生效 | 不跨重启 |
| 端口占用 | warn 不监听，应用正常 | 同上 |
| 无 Host / Host 死 / 应答超时 | 503 unavailable_host（超时兜底 300s） | — |
| Host responder 抛错 | ok:false → 503 | — |
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

- `[local-task-api]` 前缀；info：`listening on 127.0.0.1:<port>`、`created task=<taskId>`（taskId 可记）；warn：config invalid、listen failed、dispatch failed；拒绝计数器（内存对象，随 health 不暴露——仅日志聚合用）。
- 不记录：prompt/text/title 内容、token、body。

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
| AC-003 | Host responder 单测（mock IZCodeTaskService，类型绑定 Pick 面）：create 参数形态（deferPersistenceUntilFirstPrompt、clientMode）、空闲 sent/运行 queued/steer（enqueue+promote 调用断言）、stop、五态投影、events 立即返回/长轮询唤醒/resync、input.queued 事件 | FR-005~FR-010, FR-012 |
| AC-004 | Main 路由单测：归属表 miss→404、无 Host→409/503、dispatcher requestId 回流/超时 | FR-011 |
| AC-005 | 上游文档 + dw 产物（卡片/CHANGELOG/决策记录/v1 spec 转 superseded） | FR-014 |
| AC-006 | typecheck / lint / 相关单测 / architecture:check --changed 真跑记录（2026-10-28 实测：typecheck 0 错；lint 0 errors / 96 条存量 warnings（本次文件零命中）；Host responder 16 用例 + Main 17 用例共 33 例全绿；architecture:check --changed OK——两新 src 文件经 unmanaged-new-file 例外登记；ctx lint-cards 0 违规） | — |
| AC-007 | 日志断言：拒绝路径计数、无 prompt 内容 | FR-013 |

**覆盖自查**：FR-001→AC-002；FR-002→AC-002；FR-003→AC-002；FR-004→AC-002；FR-005→AC-003；FR-006→AC-003；FR-007→AC-003；FR-008→AC-003；FR-009→AC-003；FR-010→AC-003；FR-011→AC-004；FR-012→AC-003；FR-013→AC-007；FR-014→AC-005。

## 12. 契约偏离（对上级契约 v2 文本；最终总结会重复列出）

| # | 偏离 | 理由 |
|---|---|---|
| 1 | `turnCount` = snapshot.messages 中 assistant 条数 | `ZCodeTaskMeta` 无原生 turnCount 字段（zcode-task-types-core.ts:276-363） |
| 2 | `steer` = enqueueTaskCommand + promoteTaskCommand 近似 | IZCodeTaskService 无 CLI v4 的 guide delivery；promote（抢跑）是旧栈最接近 steer 的原语 |
| 3 | stopped 终态 → `turn.completed`（text 空） | 契约事件闭集无 stopped 类型 |
| 4 | ZCode 重启后旧 taskId → 404（非本 API 创建的任务同理） | Main 归属表进程内存；tasks-index 无按 taskId 反查 workspace 的服务接口；行为确定优先 |
| 5 | workspace 未打开 → 409（不自动打开） | 契约第 10 条二选一；自动打开链长时机不定（A2 调查） |
| 6 | workspaceIdentity 非空（远端 workspace）→ 409 | v2 只做本地 workspace；路由表 workspaceKeys 只含本地 |
| 7 | 检查顺序：Host 头(403) → Bearer(401) → Content-Type(415) → 大小(413) | DNS rebinding 防护先于鉴权；契约未定顺序 |
| 8 | `input.queued`/`input.steered` 事件由 API 自身在受理成功时产生（非流事件投影） | CLI 流不区分 API 投递来源；受理即事实 |

## 13. 过稿记录（MUST）

- 2026-10-28 ｜ 拍板人显式跳过 ｜ 上级任务书延续 v1 的跳过声明（方案变更指令即拍板）。

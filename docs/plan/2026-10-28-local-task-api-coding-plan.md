---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-28'
authority_refs:
  - 'LocalTaskApiRequest/Response 消息形状（spec §2）'
  - 'Host responder 六 op 行为（spec §4）'
  - 'createLocalTaskApi(deps) 与 dispatcher 注入形状'
---

# 本机任务 API（契约 v2）Coding Plan

**Goal:** Main 起 loopback 任务 API，按 workspace 路由到拥有 Host，Host 调 IZCodeTaskService 完成建任务/发消息/停止/查询/事件长轮询。
**Architecture:** shared 消息对（op 联合）→ Host responder（业务 + 事件 ring buffer）→ Main HTTP（鉴权/校验/路由/归属表/dispatcher）→ 接线三处小改。
**Worktree:** /Users/weidwonder/projects/ZCode/.worktrees/local-bot-webhook ｜ **Branch:** feat/local-bot-webhook ｜ 合并：派发者负责。

**模型分工（用户要求）**：代码与测试由 model:"haiku" 的内部子代理编写；本会话负责拆分、任务书、审读、修偏、验证与提交。haiku 同一处两次返工不过的部分由本会话接手（总结中写明分工）。

**分工实际执行记录（2026-10-28）**：Task 1（shared 消息对 + Host responder + 16 用例）与 Task 2（Main HTTP + 接线 + 17 用例）各由一个 haiku 子代理一次过（typecheck 0 错、测试全绿，歧义决定合理，主会话复核确认）；本会话审读后仅修 7 处 lint unsafe-optional-chaining 警告（1742b785）。上游文档与全部 dw 产物由本会话编写。

---

### Task 1（haiku）：shared 消息对 + Host responder + 测试

**满足:** FR-012 及 FR-005~FR-010 的 Host 侧 ｜ **依赖:** 无

**Files:**
- Modify: `packages/shared/src/channels.ts`、`packages/shared/src/validation.ts`
- Create: `packages/desktop/src/host/localTaskApiResponder.ts`
- Modify: `packages/desktop/src/host/index.ts`（3 处小改：import、responder 实例、消息 case）
- Create: `packages/desktop/test/localTaskApiResponder.test.ts`

**Interfaces（任务书全文给出，haiku 照抄）:**
- `HostMessageTypes.LocalTaskApiRequest = "local-task-api-request"`；`HostResponseTypes.LocalTaskApiResponse = "local-task-api-response"`。
- zod schema `localTaskApiRequestOpSchema`（discriminated by kind）与两个消息 schema（spec §2 形状）+ TS 类型导出 `HostLocalTaskApiRequestMessage` / `HostLocalTaskApiResponseMessage`。
- `createLocalTaskApiResponder(deps: { getServices, post, now?, randomUUID? })` → `{ handleRequest(msg) }`。
- 业务面类型 `LocalTaskApiTaskService = Pick<IZCodeTaskService, "createTask"|"sendPrompt"|""|""|"stopGeneration"|"getTaskSnapshot"|"getTaskMeta"|"listTasks"|"listActiveTaskIds"|"renameTask"|"onDynamicTaskEvent"|"onDynamicTaskTerminalOutcome">`（签名变化编译红）。

**要点:** 六 op 按 spec §4 实现；事件 ring buffer（每 task 500 条 + waiter 长轮询（唤醒按各 waiter 的 after 过滤）+ resync）；订阅生命周期（create/send 受理时建立，任务终态后 10 分钟整体释放订阅与缓冲（懒重建，after>0 回 resync）；其余随 Host 进程退出回收——responder 不单独接入 disposeHostResources 链，属有意取舍）；无 services → status 503 body {error:"unavailable_host"}；异常 catch → ok:false（出站固定文案，原文进日志）。

### Task 1b（评审轮追加，haiku + 主会话）：taskId 重锚定与评审修复

**满足:** FR-015、FR-016 及评审 r2-27/28/29 各项 ｜ **依赖:** Task 1/2

- Main：`:taskId` 端点可选 workspacePath 重锚定（bc566a4c）；clientRequestId 10 分钟去重；mode 枚举白名单；开关文件权限 warn；Host 退出结清在飞请求；拒绝日志与计数输出口；create 登记条件放宽到 2xx 带 taskId。
- Host：send/stop/events 前置 getTaskMeta 归属校验；create 部分失败 201+warning；summary 用真实字段；get 单读快照；终态修剪；op 异常固定文案。
- 测试：Main 21→28、Host 18→24（详见 spec AC-008/009；52/52 实测全绿）。

**验证:** `pnpm vitest run packages/desktop/test/localTaskApiResponder.test.ts` + `pnpm typecheck`。

### Task 2（haiku）：Main HTTP + 接线 + 测试

**满足:** FR-001~FR-004, FR-011, FR-013 ｜ **依赖:** Task 1 消息常量

**Files:**
- Create: `packages/desktop/src/main/localTaskApi.ts`（不 import electron）
- Modify: `packages/desktop/src/main/index.ts`（import + 归属表 + 路由函数 + whenReady 创建 + prepareAppQuit 关闭，≤20 行）
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`（应答回流 case 3 行）
- Create: `packages/desktop/test/localTaskApi.test.ts`

**Interfaces:** `createLocalTaskApi(deps: {readConfig?, dispatch, resolveHost, registerTask?, zcodeVersion, logger}) → Promise<Server|null>`；`createLocalTaskApiDispatcher(deps: {getHost, timeoutMs?})`（v1 同型）；`readLocalTaskApiConfig(configDir?)`。

**要点:** 校验顺序 Host头→Bearer(sha256+timingSafeEqual)→Content-Type→大小；开关 token≥32；路由：URL → taskId 查归属表（send/stop/get/events）→ workspacePath → resolveHost → dispatch；无 Host → 409（create/list）或 503（有归属但 Host 全没了→409，见 spec 决策表）；日志含拒绝计数。

**验证:** `pnpm vitest run packages/desktop/test/localTaskApi.test.ts` + typecheck。

### Task 3（haiku）：上游文档

**满足:** FR-014（docs 部分） ｜ **依赖:** Task 2 行为定型

`docs/local-task-api.md`（英文）：开关文件、鉴权、端点清单、事件类型、错误码、限制（409/404 语义、重启归属、buffer 500 条）。

### Task 4（本会话）：dw 产物与验证

卡片（desktop-host-ipc 刷新 + 新 local-task-api 域卡 + registry）、CHANGELOG 重写、architecture-policy 例外改新文件名、`ctx lint-cards`、typecheck/lint/单测/architecture:check 全量真跑、spec AC 回填。

---

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| haiku 类型漂移/编译错 | M | 任务书全文给类型；typecheck 先行；两次返工本会话接手 |
| sendPrompt traceId 语义误用 | M | create 首条用 createResult.traceId（先例 host/index.ts:777）；续聊新 randomUUID |
| 事件订阅泄漏 | M | 终态 10 分钟整体释放订阅与缓冲（懒重建）；其余随 Host 进程退出回收 |
| taskRealtimeBus hosts 注册表访问方式不确定 | M | Task 2 前本会话先核实 bus 实例暴露形态（main/index.ts） |

## 替换清单核销
（v1 已整体回退，无遗留替换物。）

## 完成与自动合并
评审门/合并门由派发者负责。

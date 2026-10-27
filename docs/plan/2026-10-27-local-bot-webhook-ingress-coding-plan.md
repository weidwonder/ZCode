---
lifecycle: superseded
superseded_by: '2026-10-28-local-task-api-coding-plan.md'
archived: '2026-10-28'
last_confirmed: '2026-10-28'
authority_refs:
  - 'handleWebhookBotCallback(params) 签名与返回形状（services 公共函数）'
  - 'HostMessageTypes.BotWebhookIngressDispatch / HostResponseTypes.BotWebhookIngressResult 的 payload 契约'
  - 'createBotWebhookIngress(deps) 的注入形状'
---

> **已归档（2026-10-28）｜lifecycle: superseded**：本文对应的 v1 方案（Webhook Bot 入站）已整体回退，由 docs/plan/2026-10-28-local-task-api-coding-plan.md（本机任务 API）取代；上述 authority_refs 指向的实体已不存在。与现行文档冲突时以现行为准，MUST NOT 据本文实施。

# 桌面版本机 Webhook Bot 入站端点 Coding Plan

**Goal:** 桌面版 Main 进程起全应用唯一的 loopback HTTP 入站端点，把 Webhook Bot 回调经现有 main→host 通道转发给 bots 服务处理，UI 放开 webhook 新建与设置。
**Architecture:** services 包抽公共回调处理函数（Web 服务与桌面共用）→ shared 加一对消息类型与 schema → Host 侧应答器 → Main 侧 ingress server（dispatch 注入可测）→ UI 三处小改 → 上游文档。
**Tech Stack:** Node http（Main 进程）、zod（消息 schema）、vitest（单测/契约测试）、React（UI）。
**Worktree:** /Users/weidwonder/projects/ZCode/.worktrees/local-bot-webhook
**Task Branch:** feat/local-bot-webhook
**目标主分支:** main（合并由派发者负责，本 plan 不含合并任务）

> 提交切分纪律：Task 1–7 的产物按「功能代码/测试/上游文档 → `feat(bots):` 系提交」「dw 专属（本 plan、eng-spec、卡片、registry、CHANGELOG）→ `chore(local-dw):` 提交」分两串提交；实现完毕后统一整理提交（见 Task 8）。

---

### Task 1：services 公共回调处理函数

**Slice:** `handleWebhookBotCallback(provider, rawBody, secret, botsService)` → `{status, body}`，独立可测。
**依赖：** 无 ｜ **满足:** FR-008

**Files:**
- Create: `packages/services/src/bots/webhookCallbackHttp.ts`
- Test: `packages/services/src/bots/webhookCallbackHttp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WebhookBotCallbackResult { status: 200 | 400 | 401 | 503; body: unknown }
  export interface WebhookBotCallbackBotsService {
    handleProviderCallbackResponse(
      provider: BotProvider, payload: unknown,
    ): Promise<BotProviderCallbackResult>;  // ← 类型绑定 IBotsService（Pick 语义），上游签名变化编译红
  }
  export async function handleWebhookBotCallback(params: {
    provider: BotProvider; botId?: string; rawBodyText: string;
    webhookSecret?: string; botsService: WebhookBotCallbackBotsService | null;
  }): Promise<WebhookBotCallbackResult>
  ```
- 状态映射规则（与 `packages/server/src/http.ts:403-445` 逐句对齐）：provider 不在 `botProviders` → 400 `Unsupported provider: <p>`；非 webhook → 400 `Provider <p> does not support HTTP callbacks.`；botsService null → 503 `Bots service is not available.`；rawBodyText 空串 → `{}`，JSON.parse 失败 → `{payload: rawBodyText}`；payload 展开 + `rawBody` + 可选 `botId`/`webhookSecret`；`responseBody ?? {ok, replies}`；`result.status∈{400,401,503}` 透传否则 200。

**Step 1–4:** 先写测试（provider 校验 400 ×2、null 服务 503、body 空串/非 JSON fallback、botId/secret 并入参数形状、responseBody 优先、status 三值透传与默认 200）再实现。实现从 `http.ts` 逻辑逐句搬移，不改语义。
**验证:** `PATH=/Users/weidwonder/projects/.toolchains/node-v24.14.0/bin:$PATH pnpm vitest run packages/services/src/bots/webhookCallbackHttp.test.ts`（根目录跑）
**Step 5:** commit `feat(bots): extract shared webhook bot callback handler in services`

---

### Task 2：Web 服务改调公共函数 + 回归测试

**Slice:** `POST /api/bots/:provider(/:botId)` 行为不变、内部改调公共函数。
**依赖：** Task 1【handleWebhookBotCallback】 ｜ **满足:** FR-008

**Files:**
- Modify: `packages/server/src/http.ts:403-448`（handleBotCallback 变薄壳）
- Test: `packages/server/test/botsHttp.test.ts`（既有 4 用例保持绿；补 1 用例：带 botId 路径段时 payload 含 botId）

**Interfaces:**
- Consumes: Task 1 的 `handleWebhookBotCallback`（`@zcode/services` 导入——同时在 `packages/services/src/index.ts` bots 导出区加 2 行：值导出函数 + type 导出接口）。

**实现要点:** 薄壳保留 Hono 取参（`c.req.param("provider")`、`c.req.text()`、头读取），调用公共函数后 `c.json(result.body, result.status)`。注意 Hono 的 `c.json(x, 400)` 与原逐分支等价；错误 body 形状 `{error: "…"}` 由公共函数产生。
**验证:** `pnpm vitest run packages/server/test/botsHttp.test.ts` 全绿。
**Step 5:** commit `feat(bots): route web bot callback through shared handler`

---

### Task 3：shared 消息类型与 schema

**Slice:** main↔host 新消息对可解析（协议先行，两侧尚未接）。
**依赖：** 无 ｜ **满足:** FR-004/FR-007 的协议部分

**Files:**
- Modify: `packages/shared/src/channels.ts`（HostMessageTypes 加 `BotWebhookIngressDispatch: "bot-webhook-ingress-dispatch"`；HostResponseTypes 加 `BotWebhookIngressResult: "bot-webhook-ingress-result"`，均带中文注释一行）
- Modify: `packages/shared/src/validation.ts`（两个 strict zod object + 挂进 `hostIncomingMessageSchema`（:962 起 discriminatedUnion）与 `hostResponseMessageSchema`（:1563 起）+ 导出 TS 类型 `HostBotWebhookIngressDispatchMessage` / `HostBotWebhookIngressResultResponse`）

**Interfaces:**
- Produces:
  ```ts
  // main → host
  { type: "bot-webhook-ingress-dispatch", requestId: string,
    botId: string | null, rawBody: string, webhookSecret: string | null,
    bodyPayload: Record<string, unknown> | { payload: string } | null }
  // host → main
  { type: "bot-webhook-ingress-result", requestId: string,
    ok: boolean, status: number, body: unknown }
  ```
  bodyPayload 的解析规则与 Task 1 公共函数一致（Main 预解析、Host 不重复解析）。

**验证:** `pnpm typecheck`（shared 包类型链路）。
**Step 5:** commit `feat(bots): add bot webhook ingress ipc message pair`

---

### Task 4：Host 侧应答器

**Slice:** Host 收到 dispatch 消息 → 调 bots 服务 → postMessage 结果。
**依赖：** Task 1、Task 3 ｜ **满足:** FR-004/FR-007

**Files:**
- Create: `packages/desktop/src/host/botWebhookIngressResponder.ts`
- Modify: `packages/desktop/src/host/index.ts`（消息分发处，`HostMessageTypes.ApplicationLocaleChanged` case 后加 ≤6 行 case 委托）
- Test: `packages/desktop/test/botWebhookIngressResponder.test.ts`

**Interfaces:**
- Consumes: `handleWebhookBotCallback`；`HostMessageTypes.BotWebhookIngressDispatch`。
- Produces:
  ```ts
  export function createBotWebhookIngressResponder(deps: {
    getServices: () => ServiceCollection | null;
    post: (message: HostBotWebhookIngressResultResponse) => void;
  }): { handleDispatch(msg: HostBotWebhookIngressDispatchMessage): Promise<void> }
  ```
  行为：services 不可用/disposed → 回 `{ok:false, status:503, body:{error:"unavailable_host"}}`；`getOptional(IBotsService)` null → 同上（对齐 Web 服务 503 `Bots service is not available.`——用 503 + error:"Bots service is not available."）；正常 → `handleWebhookBotCallback({provider:"webhook", botId: msg.botId ?? undefined, rawBodyText: msg.rawBody, webhookSecret: msg.webhookSecret ?? undefined, botsService})` → 回 `{ok:true, status, body}`；任何异常 catch → `{ok:false, status:503, body:{error:"unavailable_host"}}` + logger warn。
- host/index.ts 的 case：
  ```ts
  if (msg.type === HostMessageTypes.BotWebhookIngressDispatch) {
    void botWebhookIngressResponder.handleDispatch(msg);
    return;
  }
  ```
  （`botWebhookIngressResponder` 在 activeServices 声明附近以工厂创建一次，deps 指向模块级 `activeServices` 的 getter 与 `parentPort.postMessage`。）

**测试要点:** mock ServiceCollection（register IBotsService mock——mock 对象类型声明为 `Pick<IBotsService, "handleProviderCallbackResponse">` 满足 `WebhookBotCallbackBotsService`，上游签名变化编译红）；断言 post 收到的 result 形状 ×（正常 200 透传 responseBody、status 503 透传、服务缺失、异常 catch）。
**验证:** `pnpm vitest run packages/desktop/test/botWebhookIngressResponder.test.ts`
**Step 5:** commit `feat(bots): handle bot webhook ingress dispatch in window host`

---

### Task 5：Main 进程 ingress server + 接线 + 契约测试

**Slice:** 真实 loopback HTTP：health / 转发 / 413 / 403 / 404 / 405 / 开关三态 / 端口占用。
**依赖：** Task 3（消息常量）；dispatch 以注入回调形式与 Task 4 解耦 ｜ **满足:** FR-001~FR-007

**Files:**
- Create: `packages/desktop/src/main/botWebhookIngress.ts`
- Modify: `packages/desktop/src/main/index.ts`（import + whenReady 内一处调用 + before-quit 关闭，≤10 行）
- Test: `packages/desktop/test/botWebhookIngress.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BotWebhookIngressDispatchPayload {
    botId: string | null; rawBody: string;
    webhookSecret: string | null;
    bodyPayload: Record<string, unknown> | { payload: string } | null;
  }
  export async function createBotWebhookIngress(deps: {
    readConfig?: () => Promise<{ enabled: boolean; port: number } | null>;  // 默认读 getAppConfigDir()/bot-webhook-ingress.json；测试注入
    dispatch: (payload: BotWebhookIngressDispatchPayload) => Promise<{ status: number; body: unknown }>;
    zcodeVersion: string;
    logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  }): Promise<http.Server | null>
  ```
- 行为细节：
  - 配置读取：文件不存在/`enabled!==true` → null（不打日志）；JSON 解析失败或 port 非法（enabled:true 时）→ warn + null。**只在创建时读一次。**
  - `http.createServer`：GET `/health` → 200 固定 JSON；GET 其它 → 404 `{"error":"not_found"}`；非 GET/POST → 405 `{"error":"method_not_allowed"}` + `Allow: GET, POST`；POST 路径仅 `/api/bots/webhook` 与 `/api/bots/webhook/<非空段>`，其它 → 404。
  - POST：先 Host 头校验（`127.0.0.1:<port>`/`localhost:<port>` 大小写不敏感）→ 403 `{"error":"host_header_forbidden"}`（不读 body，直接回）；再流式收集 body，>16 MiB → 413 `{"error":"payload_too_large"}` 并 destroy socket；然后 `dispatch` → `res.writeHead(status)` + JSON body。dispatch 抛错 → 503 `{"error":"unavailable_host"}`。
  - 响应头固定 `content-type: application/json`，**无任何 CORS 头**。
  - `listen` 失败（EADDRINUSE 等）→ warn + resolve null，不抛。
  - 关闭：返回 server，调用方在 before-quit `server.close()`；server 也监听自身 `close` 清 pending（无 pending Map——dispatch 是注入回调，超时/清理由注入方实现，本模块不持有跨请求状态）。
- main/index.ts 接线（whenReady 内，setDataBaseDir 之后）：
  ```ts
  void createBotWebhookIngress({
    dispatch: (payload) => requestBotWebhookIngressDispatch(payload),  // 同文件新 import 的小转发器：取 windowHostProcessMap 首个存活 Host，postMessage + requestId pending + 300s 超时；无 Host reject
    zcodeVersion: ZCODE_VERSION || app.getVersion(),
    logger,
  }).then((server) => { botWebhookIngressServer = server; });
  ```
  转发器实现放 `botWebhookIngress.ts` 同文件导出 `createBotWebhookIngressDispatcher({getHost, timeoutMs})`（返回 dispatch 函数；pending Map + requestId + 超时 503；照 `resourceManagerHostSampling.ts` 形态）。应答回流：`desktopHostProcess.ts` 的 `child.on("message")` 里加 3 行（`BotWebhookIngressResult` → 调 dispatcher 的 `resolveResult`）——该文件是消息路由的现有家，属最小注册行。
- **契约测试**（真实 listen 端口 0 或指定随机空闲端口，注入 readConfig/dispatch）：
  1. health：200 + 四字段形状 + zcodeVersion 透传
  2. Host 头非法（带 `Host: evil.com` 的原始请求）→ 403；合法两种（127.0.0.1/localhost）→ 放行
  3. dispatch mock 返回 {status:200,body:{ok:true,replies:[]}} → 透传；{401}、{400}、{503} 同理
  4. dispatch 收到的 payload：路径 botId、body 原文、secret 头、bodyPayload 预解析
  5. body 路径 botId 缺省（`/api/bots/webhook`）→ payload.botId null
  6. 16MiB+1 → 413
  7. GET /api/bots/webhook → 404；DELETE /health → 405
  8. 开关三态：readConfig null → 返回 null 不监听；enabled false → null；解析失败 → null
  9. 端口占用：先占一个端口再创建 → resolve null 不抛
  10. dispatch reject → 503 unavailable_host
  11. dispatcher 单测：postMessage 被调、requestId 匹配、resolveResult 应答、超时 503、无 Host reject
- **测试不依赖 Electron**：botWebhookIngress.ts 只用 node:http 与注入 deps（`getHost: () => ({postMessage} ) | null`），main/index.ts 的 import 通过 vitest 不加载（契约测试直接 import botWebhookIngress.ts；该文件不得顶层 import electron）。

**验证:** `pnpm vitest run packages/desktop/test/botWebhookIngress.test.ts`；`pnpm typecheck`。
**Step 5:** commit `feat(bots): local webhook bot ingress server in desktop main`

---

### Task 6：UI 放开 webhook + 设置卡 + i18n

**Slice:** 用户能在桌面 Bots 设置里新建 Webhook bot、填 webhookUrl 与 secret 并保存。
**依赖：** 无（与 Task 1–5 并行可做） ｜ **满足:** FR-009/FR-010/FR-011

**Files:**
- Modify: `packages/ui/src/BotsDialog.tsx:1109`（去 filter）
- Modify: `packages/ui/src/BotsDialog.tsx`（saveBot 支持 `webhookSecretValue`；ProviderSettingsCard 的 props 加 `onSaveWebhookUrl`/`onSaveWebhookSecret`，接线处实现）
- Modify: `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx:161-163`（webhook 分支渲染设置卡）
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts` + `en-US.ts`（新增 key，成对）

**实现要点:**
- webhook 设置卡结构（复用 SettingsGroupCard/SettingsRow/Input/Button，参照 Telegram 分支与 weixin 卡的控件形态）：一行 webhookUrl（Input + 保存按钮，保存 `patchSelectedBot({webhookUrl: value || undefined})`——空串清 undefined，与 zod `.url().optional()` 对齐）；一行 secret（type=password Input + 保存按钮 → `saveBot(selectedBot, {webhookSecretValue})`；已存 `webhookSecretRef` 时显示已保存态 + 移除按钮 → 既有 `onRemoveSecret`（removeBotSecret））。
- `bots.botTokenDescription.webhook` 已存在（zh-CN.ts:1072）可直接用作行描述；secret/url 的 label/description/按钮文案新 key：`bots.webhookUrl.label`、`bots.webhookUrl.description`、`bots.webhookSecret.label`、`bots.webhookSecret.description`、`bots.webhookSecret.saved`、`bots.webhookSecret.remove`（中英成对，措辞见实现）。
- local state（webhookUrlDraft/secretDraft）放 BotsDialog（与 credentialValue 同层），ProviderSettingsCard 保持受控 props。

**验证:** `pnpm typecheck`（UI 类型）+ `pnpm lint`（ui 包）。
**Step 5:** commit `feat(bots): expose webhook provider creation and settings in bots dialog`

---

### Task 7：上游文档

**Slice:** PR 附带的产品/技术文档（英文、只写事实）。
**依赖:** Task 5（端点行为定型） ｜ **满足:** FR-012

**Files:**
- Create: `docs/bot-webhook-ingress.md`（英文；内容：动机一段、开关文件、端点清单（health/两个 POST）、安全边界（loopback/Host 头/secret 在 bots 层/body 上限）、与 Web 服务关系（共享 services 处理函数、语义一致）、限制（重启生效、单实例、无 CORS））
- Modify: `docs/bots.md:246-252`（"Webhook inbound requests continue through" 段落处加桌面端点一句 + 链接）

**验证:** 文中引用的路径/端口/字段与实现一致（人工核）。
**Step 5:** commit `feat(bots): document desktop local webhook bot ingress`

---

### Task 8：CHANGELOG、卡片刷新、验证汇总

**Slice:** dw 专属产物归位 + 全量验证真跑。
**依赖:** Task 1–7 ｜ **满足:** —（流程性）

**Files:**
- Create/Modify: 仓库根 `CHANGELOG.md`（`## 未发布` 下五节形态按 dw 纪律建全；`新增` 一条：desktop local webhook bot ingress endpoint + webhook bot UI；对外不可见的抽函数/消息对写 `内部`）
- Modify: `engineering-context/cards/ZCode/bots-webhook-callback.md`、`desktop-host-ipc.md`（补回新文件行——此时 cite 可解析）+ `ctx lint-cards` 绿
- Modify: 本 plan 与 eng-spec 的核销列。

**验证（全量，真跑并记录真实结果）:**
1. `PATH=/Users/weidwonder/projects/.toolchains/node-v24.14.0/bin:$PATH pnpm typecheck`
2. `pnpm lint`
3. `pnpm vitest run packages/services/src/bots/webhookCallbackHttp.test.ts packages/server/test/botsHttp.test.ts packages/desktop/test/botWebhookIngress.test.ts packages/desktop/test/botWebhookIngressResponder.test.ts`
4. `pnpm architecture:check --changed`

**Step 5:** commit `chore(local-dw): changelog, cards, spec status for local bot webhook ingress`

---

### Checkpoint：Task 8 之后
- [ ] 上述 4 条验证命令全绿（失败如实记录）
- [ ] spec FR 全部被 Task 覆盖：FR-001~007→T5、FR-008→T1/T2、FR-009/010/011→T6、FR-012→T7
- [ ] 评审门与合并由派发者另派（不在本 plan）

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| `pnpm install` 失败/原生模块编译失败（ELECTRON_SKIP_BINARY_DOWNLOAD） | H | 记录真实错误进总结；typecheck/lint/单测多数不依赖原生模块；不行时报告派发者 |
| host/index.ts case 插入点选取不当（文件 4157 行） | M | case 加在 ApplicationLocaleChanged 之后（同区域无状态依赖）；vitest + typecheck 兜底 |
| i18n key 命名与现有惯例不符 | L | 参照 `bots.*` 现有 key 风格；lint 不查文案，人工核对成对 |
| Hono `c.json(body, status)` 与原分支响应差异 | M | Task 2 回归测试逐用例对照原断言（既有 4 用例不动） |

## 替换清单核销（来自 spec §8.2）

| 被取代物 | 删除任务 | 实测引用数 | 核销 |
|---|---|---|---|
| http.ts handleBotCallback 内联处理段（逻辑搬移到 services） | Task 2（函数保留为薄壳，无符号删除） | —（无引用变化） | ✅ 行为等价由回归测试证明（botsHttp.test.ts 既有 4 用例 + 新增 1 用例全绿） |

## 完成与自动合并
- 评审门/合并门由派发者负责（任务书明示），本 plan 不含合并任务；worktree 与分支保留不删。

---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-27'
authority_refs:
  - '桌面版本机入站端点 POST /api/bots/webhook(/:botId) 行为契约（见 docs/bot-webhook-ingress.md）'
  - '开关文件 bot-webhook-ingress.json 的读取语义（enabled/port）'
  - 'services 包 webhook 回调公共处理函数 handleWebhookBotCallback 的参数与返回形状'
  - 'main↔host 新消息对 BotWebhookIngressDispatch / BotWebhookIngressResult 的 payload 契约'
---

# ZCode_技术 Spec — 桌面版本机 Webhook Bot 入站端点

> 单仓库详细技术规范。遵循 `spec写作纪律.md`：零上下文可动手、RFC2119、无占位符。
> 本文是 dw 专属产物（随 `chore(local-dw):` 提交）；随 PR 给上游的产品/技术文档另见 `docs/bot-webhook-ingress.md`（英文，平铺在 docs/ 下，随 `feat(bots):` 提交）。

## 0. 阅读导引（MUST，前置）

- **一句话目的**：让外部本机程序能通过 HTTP 把任务以 Webhook Bot 消息形式投给 ZCode 桌面版（跑在桌面运行时里、GUI 可见），桌面版把回复 POST 回投递方。
- **端到端场景**：
  1. 用户在 `<appConfigDir>/bot-webhook-ingress.json` 写 `{"enabled":true,"port":47821}` → 启动 ZCode 桌面版 → Main 进程在 `127.0.0.1:47821` 监听 → 桥接程序 `GET /health` 得 200 确认在线。
  2. 桥接程序 `POST /api/bots/webhook/<botId>`（头 `x-zcode-bot-secret`，body JSON 消息）→ Main 校验 Host 头/大小 → 经现有 main→host requestId 通道转发给任一存活窗口 Host → Host 调 `IBotsService.handleProviderCallbackResponse("webhook", …)` → 结果沿原路回给桥接程序（200/400/401/503 透传）。
  3. 异常：开关文件缺失/损坏/未启用 → 不监听；端口被占 → warn 日志、应用照常启动；所有窗口关闭（macOS）→ 监听仍在，但 POST 因无存活 Host 回 503。
- **核心流程图**：
  ```mermaid
  flowchart TD
    A[Main whenReady] --> B[读开关文件 getAppConfigDir/bot-webhook-ingress.json]
    B -->|enabled!=true 或解析失败| X[不监听]
    B -->|enabled| C[http listen 127.0.0.1:port]
    C --> D{请求}
    D -->|GET /health| E[200 直接回]
    D -->|POST /api/bots/webhook/:botId?| F[Host 头校验 → body≤16MiB]
    F -->|违规| G[403 / 413]
    F -->|通过| H[选任一存活 Host → requestId postMessage]
    H -->|无 Host / Host 退出| I[503]
    H -->|Host 应答| J[status+body 透传]
    D -->|其它| K[404 / 405]
  ```
- **决策表**：

| 输入 / 状态 | 条件 | 走向 / 处置 | 结果 |
|---|---|---|---|
| 开关文件 | 不存在 / JSON 解析失败 / `enabled!==true` | 不建 server（解析失败打 warn） | 无监听 |
| 开关文件 | `enabled:true` 且 `port` 合法（1–65535） | 建 server | 监听 `127.0.0.1:port` |
| `port` 非法（非整数/越界） | 视同解析失败 | warn + 不监听 | 无监听 |
| 端口占用（EADDRINUSE） | listen 报错 | warn 日志，不抛出 | 应用照常启动、无监听 |
| `GET /health` | Host 头不校验 | 直接回 200 JSON | `{"ok":true,"ingress":"zcode-bot-webhook","version":1,"zcodeVersion":"…"}` |
| 非 GET/POST 方法 | — | 405 | — |
| GET 非 `/health` / POST 其它路径 | — | 404 | — |
| POST 目标路径 | Host 头 ≠ `127.0.0.1:port`/`localhost:port` | 403 | — |
| POST body | > 16 MiB | 413 | — |
| POST 转发 | 无存活 Host / Host 中途退出 / 应答超时 | 503 | — |
| POST 转发 | Host 应答 | 透传 status（200/400/401/503）与 body | — |

## 1. 范围

- 本仓库（ZCode，单仓）做什么：
  - services 包：把 `packages/server/src/http.ts:403-445` 的 `handleBotCallback` 中与框架无关的部分抽成公共函数，Web 服务与桌面端共用。
  - shared 包：新增 main↔host 消息对（类型常量 + zod schema）。
  - desktop 包：Main 进程本机 HTTP 入站端点（新文件）+ Host 侧应答器（新文件）+ 两个最小注册行（main/index.ts 的启动接线、host/index.ts 的消息 case）。
  - ui 包：新建 bot 列表放开 webhook + webhook 设置卡（webhookUrl / secret）。
  - docs：`docs/bot-webhook-ingress.md`（上游文档）+ `docs/bots.md` 指针。
- **不做什么**：
  - 不实现桥接程序（另一子任务）。
  - 不改出站 webhook 行为（`webhookProvider.ts` 的 send/test 不动）。
  - 不打包、不安装桌面应用。
  - 不加开关文件之外的任何配置项（无环境变量、无 settings 项、无 CLI 参数）。
  - 不做跨 Host 的消息幂等（与 Web 服务单实例语义对齐：单 Host 处理即进程内幂等）。
  - 不做 TLS（只绑 loopback）。
- **依赖的上游 / 被依赖的下游**：
  - 依赖 `@zcode/services` 的 `IBotsService.handleProviderCallbackResponse(provider, payload)`（`packages/services/src/bots/bots.ts:209-212`）——上游签名变化时契约测试 MUST 失败（见 §11 AC-007）。
  - 依赖 `getAppConfigDir()`（`packages/services/src/paths.ts:56-58`；`{dataBaseDir}/.zcode/v2`，dataBaseDir 优先级 `setDataBaseDir()` > env > homedir，`paths.ts:37-43`）。
  - 下游：外部桥接程序按「共享接口契约 v1」消费本端点（本文 §3 即该契约的实现规范）。

- **既有系统清单**（穷举不判断）：

| 既有模块 / 机制 | 从哪知道它的 | 本次可能怎么碰到 | 卡片补了吗 |
|---|---|---|---|
| `handleBotCallback`（Web 服务 bots 回调路由） | `packages/server/src/http.ts:403-448` | 抽公共函数后由它调用，行为 MUST 不变 | 本次新补 `cards/ZCode/bots-webhook-callback.md` |
| `createWebhookBotProvider` / `parseCallback`（webhook 适配器） | `packages/services/src/bots/providers/webhookProvider.ts:168-290` | 不改；入站字段解析语义的权威出处 | 同上 |
| `processProviderCallback`（回调处理与 secret 校验、status 产生） | `packages/services/src/bots/botsService.ts:3696-3772`、secret 校验 `3836-3842` | 不改；状态码 400/401/503 的语义来源 | 同上 |
| `IBotsService` descriptor 与创建 | `packages/services/src/bots/bots.ts:215`；注册 `packages/services/src/node.ts:2681-2699` | Host 侧 getOptional 取用 | 同上 |
| window-scoped Local Host（每窗口一个 utilityProcess Host，内含 createLocalServices） | `packages/desktop/src/host/index.ts:3751`（InitLocal→createLocalServices）；`packages/desktop/src/main/desktopWindowLifecycle.ts:99,135,219` | Host 是 bots 服务宿主，转发目标 | 本次新补 `cards/ZCode/desktop-host-ipc.md` |
| main→host requestId postMessage 模式 | 先例 `packages/desktop/src/main/resourceManagerHostSampling.ts`（全文件）；分发 `packages/desktop/src/main/desktopHostProcess.ts:299` | 照该模式新增一对消息 | 同上 |
| host 消息入口与 zod 校验 | `packages/desktop/src/host/index.ts:2945-2964`；`packages/shared/src/validation.ts:962`（hostIncomingMessageSchema） | 加一个 case + schema 项 | 同上 |
| main 侧存活 Host 表 | `packages/desktop/src/main/index.ts:661`（windowHostProcessMap）；「任一本地 host」先例 `resolveCronDispatchHost`（`main/index.ts:698-701`） | 选转发目标 | 同上 |
| Bot channel runtime 跨进程锁（telegram polling lock 等） | `packages/services/src/bots/telegramChannelRuntime.ts:105-127` | 不碰；webhook 无轮询锁，任何 Host 可处理 | 同上 |
| `getAppConfigDir()` / `setDataBaseDir()` | `packages/services/src/paths.ts:37-58`；main 启动注入 `packages/desktop/src/main/index.ts:2082` | 开关文件路径 | 同上 |
| 新建 bot 列表 webhook 过滤 | `packages/ui/src/BotsDialog.tsx:1109` | 去掉 filter | 本次新补 `cards/ZCode/bots-ui.md` |
| `ProviderSettingsCard` webhook 早退 | `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx:161-163` | webhook 分支改为设置卡 | 同上 |
| UI `saveBot`（`botsService.saveBot({bot, credentialValue})`） | `packages/ui/src/BotsDialog.tsx:300-317` | 扩展支持 `webhookSecretValue`；服务端已有该参数（`botsService.ts:8186-8190`） | 同上 |
| docs/bots.md webhook 段落 | `docs/bots.md:82`（声称 webhook 已在新建列表可得——与代码 filter 不一致）、`docs/bots.md:246-252`（入站 `POST /api/bots/webhook` 段） | 加桌面端点指针；本次让代码与 82 行声明一致 | 文档轴处理 |

### 1.1 功能需求（MUST 编号）

| 编号 | 需求 |
|---|---|
| FR-001 | 开关文件：`<getAppConfigDir()>/bot-webhook-ingress.json`，内容 `{"enabled":true,"port":<1-65535>}`；文件不存在 / 解析失败 / `enabled!==true` / port 非法 → 不监听（解析失败与 port 非法打 warn）；只在启动时读取一次。 |
| FR-002 | 监听只绑 `127.0.0.1:<port>`；端口占用打 warn、不影响应用启动；整个应用同一时刻至多一个监听（挂 Main 进程）。 |
| FR-003 | `GET /health` 无需鉴权返回 200 `{"ok":true,"ingress":"zcode-bot-webhook","version":1,"zcodeVersion":"<应用版本>"}`；不返回其它信息。 |
| FR-004 | `POST /api/bots/webhook/:botId` 与 `POST /api/bots/webhook`（botId 放 body）语义与 Web 服务 `handleBotCallback` 完全一致：头 `x-zcode-bot-secret`，body 经 services 公共函数解析并调 `IBotsService.handleProviderCallbackResponse("webhook", {…body, rawBody, botId?, webhookSecret?})`，响应 `responseBody ?? {ok, replies}`，状态 200/400/401/503 透传。 |
| FR-005 | Host 头校验：POST 的 `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403；响应不带 CORS 头。 |
| FR-006 | POST body 上限 16 MiB，超出 413；其它方法 405、其它路径 404。 |
| FR-007 | 转发经现有 main→host requestId postMessage 机制到任一存活本地窗口 Host；无存活 Host、Host 应答前退出或超时（300s 上限防泄漏）→ 503 JSON。 |
| FR-008 | services 包公共函数 DRY：provider 校验、body 解析、`handleProviderCallbackResponse` 调用、状态映射收口一处；Web 服务路由改调它且行为不变。 |
| FR-009 | UI：新建 bot 列表显示 Webhook 项（去掉 `BotsDialog.tsx:1109` 的 filter）。 |
| FR-010 | UI：webhook bot 的 provider 设置卡可填 `webhookUrl` 并保存到 bot 配置；可填 secret 并以 `saveBot` 的 `webhookSecretValue` 参数保存（存为 `webhookSecretRef`，不在配置文件落明文）。 |
| FR-011 | i18n：新增文案中英双语（zh-CN 与 en-US 同 key）。 |
| FR-012 | 上游文档 `docs/bot-webhook-ingress.md`（英文、只写产品与技术事实）+ `docs/bots.md` 加指针。 |

## 2. 数据模型 / 数据结构

- **开关文件**（`bot-webhook-ingress.json`，zod：`z.object({ enabled: z.boolean().optional(), port: z.number().int().min(1).max(65535).optional() }).strict()`；`enabled` 缺省视为 false）：
  - `enabled: boolean` — true 才监听。
  - `port: number` — 监听端口；`enabled:true` 时 REQUIRED（缺失视同配置无效，warn 不监听）。
- **main→host 消息** `BotWebhookIngressDispatch`（进 `HostMessageTypes`，channels.ts）：
  ```ts
  { type: "bot-webhook-ingress-dispatch", requestId: string,
    botId: string | null,            // 路径段；无则 null（botId 需在 body）
    rawBody: string,                 // 请求 body 原文（UTF-8 文本，与 Web 服务 c.req.text() 等价）
    webhookSecret: string | null }   // x-zcode-bot-secret 头，缺省 null
  ```
  Host 把 `rawBody` 原文交给公共函数解析（解析逻辑只存在于公共函数一处，消息层不做预解析副本）。
- **host→main 应答** `BotWebhookIngressResult`（进 `HostResponseTypes`）：
  ```ts
  { type: "bot-webhook-ingress-result", requestId: string,
    ok: boolean,                     // 通道是否成功（false 时 Main 回 503）
    status: number,                  // 200/400/401/503
    body: unknown }                  // responseBody ?? {ok, replies}
  ```
- **消息 ID 常量**：`bot-webhook-ingress-dispatch` / `bot-webhook-ingress-result`（lowercase-kebab，与现有值同风格）。

## 3. 接口契约

| 接口 | 入参 | 出参 | 调用方 | 版本 |
|---|---|---|---|---|
| `GET /health` | — | 200 `{ok:true, ingress:"zcode-bot-webhook", version:1, zcodeVersion:string}` | 桥接程序 | V1 |
| `POST /api/bots/webhook/:botId` | 头 `x-zcode-bot-secret`；body JSON `{botId?, userId, text, messageId, chatId?, chatType?, displayName?, attachments?}`（字段解析权威：`webhookProvider.ts#parseCallback`） | `responseBody ?? {ok, replies}`；status 200/400/401/413/503 | 桥接程序 | V1 |
| `POST /api/bots/webhook` | 同上，botId 必须在 body | 同上 | 桥接程序 | V1 |
| `handleWebhookBotCallback`（services 公共函数，新） | `{provider: BotProvider, botId?: string, rawBodyText: string, webhookSecret?: string, botsService: Pick<IBotsService,"handleProviderCallbackResponse">}` | `Promise<{status: 200\|400\|401\|503, body: unknown}>` | Web 服务路由、desktop Host 应答器 | V1 |
| `createBotWebhookIngress`（desktop main，新） | `{configDirRead 开关文件}` + `{dispatch: (payload) => Promise<{status,body}>, zcodeVersion, logger}` | `Promise<HttpServer \| null>`（null=未启用/未监听） | main/index.ts 接线 | V1 |

**错误码**（HTTP status 即稳定码，JSON body 附 `error` 字段时用 lowercase_underscore 短语）：`unavailable_host`（无 Host/Host 退出/超时 → 503）、`host_header_forbidden`（403）、`payload_too_large`（413）。bot 业务错误文案由 bots 服务产生（`webhookSecretInvalid` 等既有 key），不在本层新造。

**外部集成契约（桥接程序消费视角）**：REQUIRED 操作 = `GET /health`、`POST /api/bots/webhook(:botId)`；传输 = loopback HTTP/1.1、无鉴权头时按无 secret 处理（与 Web 服务一致）；**本端点不做哪些写操作**：不改 bot 配置、不创建 bot、不触发出站 webhook 之外的任何副作用（消息处理本身由 bots 服务既有语义决定）。

## 4. 核心逻辑 / 流程

1. **公共函数 `handleWebhookBotCallback`**（`packages/services/src/bots/webhookCallbackHttp.ts`，新文件）——逐句对应现 `http.ts:403-445`：
   ```
   输入 provider ∉ botProviders → {400, {error:"Unsupported provider: <p>"}}
   provider ≠ "webhook" → {400, {error:"Provider <p> does not support HTTP callbacks."}}
   botsService 未提供（null）→ {503, {error:"Bots service is not available."}}
   rawBodyText 空 → rawBody={}；否则 JSON.parse，失败 → {payload: rawBodyText}
   payload = {...(对象则展开否则 {payload: rawBody}), rawBody: rawBodyText, ...(botId), ...(webhookSecret)}
   result = await botsService.handleProviderCallbackResponse(provider, payload)
   body = result.responseBody ?? {ok: result.ok, replies: result.replies}
   status = result.status∈{400,401,503} ? result.status : 200
   ```
   Web 服务 `handleBotCallback` 改为：取参/读 body/读头后调它，再 `c.json(body, status)`。
2. **Main 端点 `createBotWebhookIngress`**（`packages/desktop/src/main/botWebhookIngress.ts`，新文件）：
   - 启动（whenReady 后，从 main/index.ts 一处调用）：读 `join(getAppConfigDir(),"bot-webhook-ingress.json")`（异步 IO）→ 不存在/未启用 → 返回 null；解析失败/port 非法 → warn 返回 null。
   - `http.createServer`，路由：
     - 方法分流：GET 只允许 `/health`（其余 GET 404）；POST 只允许两个 webhook 路径（其余 404）；其它方法（含 OPTIONS/HEAD）405 `{"error":"method_not_allowed"}`，响应带 `Allow: GET, POST`。**不发任何 CORS 头**。
     - `/health`：200 固定 JSON（`zcodeVersion` 由注入）。
     - POST：Host 头白名单校验（`127.0.0.1:<port>` / `localhost:<port>`，大小写不敏感）→ 403；收集 body 至 16 MiB（超限销毁连接回 413）→ `dispatch`（注入的转发回调，见接线）→ 应答透传。
   - dispatch 注入实现（同文件或接线处）：取 `windowHostProcessMap` 第一个存活 Host → 无 → 503；`postMessage({type: BotWebhookIngressDispatch, requestId, …})`，pending Map 按 requestId 等应答；`EADDRINUSE` → warn 返回 null；Host `exit` 事件清它的 pending → 503；300s 兜底超时 → 503。
   - 生命周期：随 app 退出关闭（`before-quit` 关 server；server.unref 不适用——需显式管理）。
3. **Host 应答器**（`packages/desktop/src/host/botWebhookIngressResponder.ts`，新文件）：导出 `handleBotWebhookIngressDispatch(msg, deps)`：`deps.getServices()` 取 `activeServices` → 无/disposed → 回 `{ok:false}`；`getOptional(IBotsService)` → 无 → 503 形状；调 `handleWebhookBotCallback` → 回 `{ok:true, status, body}`。`host/index.ts` 消息分发加一个 case（≤5 行）委托它。
4. **UI**：
   - `BotsDialog.tsx:1109`：`BOT_PROVIDERS.filter(...)` 去掉（列表直接 `.map`）。
   - `ProviderSettingsCard.tsx`：webhook 分支不再 `return null`，渲染设置卡（`SettingsGroupCard`+`SettingsRow`，与现有 provider 卡同构）：webhookUrl 输入（保存走 `onSaveWebhookUrl(url)` → `patchSelectedBot({webhookUrl})`）+ secret 输入（`onSaveWebhookSecret(value)` → `saveBot(bot, {webhookSecretValue})`）+ 已存 secret 的清除（`saveBot({...bot, webhookSecretRef: undefined})`——**待核对服务端 saveBot 对 webhookSecretRef 的清除语义**，见 §12）。
   - `BotsDialog.tsx` 的 `saveBot` 增加 `webhookSecretValue` 透传（`BotSaveBotParams` 已有该字段，`botsService.ts:8186-8190`）。
5. **Main 接线**（`main/index.ts`，最小改动 ~10 行）：import 新模块；`whenReady` 内在 `setDataBaseDir` 之后、建窗前后皆可（监听不依赖窗口，但 dispatch 需 `windowHostProcessMap`——Map 是模块级常量，可闭包引用）调用 `createBotWebhookIngress`，dispatch 回调包 `desktopHostProcess` 的 child exit 清理（child exit 由 `desktopWindowLifecycle.ts:283` 的 map 删除时联动——**接线处监听 windowHostProcessMap 变化不可行（Map 无事件），改为 dispatch 失败即 503 + postMessage try/catch**；Host 应答永不返回时由 300s 超时兜底）。

**设计自检**（每引入一个新层写它解决的问题）：
- 新消息对（shared）：Main 与 Host 分进程，postMessage 是唯一通道——无它无法转发。服务 FR-004/FR-007。
- 公共函数（services）：Web/桌面两处需要同一解析+映射规则——无它必然复制漂移。服务 FR-008。
- dispatch 注入而非直连：让 `createBotWebhookIngress` 可单测（不需要真 Electron Host）。服务测试要求 (a)。
- **备选方案**：监听挂 Host 内 + 跨进程文件锁抢占（仿 telegramPollingLock）——被否：窗口关闭时端点消失，macOS 无窗口常态下桥接失联；监听可用性 MUST 只随应用进程。Main 作为 @zcode/rpc ChannelClient 连 Host——被否：无先例、在已有 postMessage 协议上叠层，违反「复用现有 IPC/RPC 机制，不要另造协议」。

## 5. 错误处理 / 降级 / 失败模型

| 失败分类 | 恢复行为 | 重启后存活性 | 操作员干预点 |
|---|---|---|---|
| 开关文件损坏/非法 | warn 不监听；改文件后重启 ZCode 生效 | 不跨重启 | warn 日志 |
| 端口被占 | warn 不监听，应用正常 | 同上 | warn 日志（换 port） |
| 无存活 Host / Host 退出 / 超时 | 该请求 503 `{"error":"unavailable_host"}`；server 存活 | — | — |
| bots 服务处理抛错 | Host 应答器 catch → `{ok:false}` → 503 | — | Host 日志 |
| body 解析失败 | 公共函数 fallback `{payload: rawBody}`（与 Web 服务一致），非错误 | — | — |

**失败模型**：无持久状态；每请求独立；pending Map 项在应答/超时/Host 退出时移除（300s 兜底防泄漏）。

## 6. 安全 / 鉴权 / 配置 / 不变量

- **信任边界**：loopback 之外的流量不可达（只绑 127.0.0.1）；Host 头校验防 DNS rebinding；secret 校验在 bots 服务（`botsService.ts:3836-3842`：bot 配置了 `webhookSecretRef` 才校验，不匹配产生拒绝 reply——**注意：现行为是业务层拒绝、HTTP 200，非 401**；401 仅 feishu/lark 路径与 prepare 失败，`botsService.ts:3708-3722,3751-3761`）。桌面端点透传该语义，MUST NOT 在端点层新造 401。
- **密钥处理**：secret 经头传输、只进内存与 CredentialService；不写日志（日志只记 requestId/status/长度）。
- **配置纪律**：见 §2 开关文件；启动读一次，改配置需重启（无 reload）。
- **安全不变量**：
  ```
  Invariant 1: 监听 socket 只绑定 127.0.0.1
  - 强制机制：listen 调用固定 host 参数；无 0.0.0.0 路径
  - 违反时：无（结构上不可达）
  Invariant 2: 同一应用进程至多一个 ingress server
  - 强制机制：server 是 whenReady 内单次创建的模块级句柄；重复创建无入口
  - 违反时：无
  Invariant 3: POST 处理前必须通过 Host 头白名单
  - 强制机制：路由处理第一步行校验
  - 违反时：403，不读 body
  ```

## 7. 可观测性

- **日志约定**：Main 用 `./logger.js` 的 `logger`（`main/index.ts:94`）；每行 `[bot-webhook-ingress]` 前缀 + `key=value`（`port=`、`requestId=`、`status=`、`error=`）；不记 body 内容与 secret。Host 侧用 host logger 同前缀。
- **sink**：Main logger（REQUIRED）；sink 失败不影响请求处理（logger 内部兜底）。
- **状态查询面**：`GET /health` 即状态面（OPTIONAL 消费）。

## 8. 兼容性 / 迁移

### 8.1 兼容取舍决策（拍板：任务书即拍板产物，2026-10-27）

| 被改变的既有行为 | 谁在依赖它 | 决定 | 到期日 | 到期动作 | 确认时间 |
|---|---|---|---|---|---|
| 桌面新建 bot 列表隐藏 webhook → 显示 | 无（现状无人能从桌面 UI 建 webhook bot） | 不兼容（直接切新行为） | — | — | 2026-10-27（任务书第 4 条明示） |
| Web 服务 `handleBotCallback` 内部实现改调公共函数 | Web 部署方 | 行为不变（任务书第 2 条：补测试证明） | — | — | 2026-10-27 |
| 其余 | — | 本次无其它既有可观察行为变化（全量新增能力） | — | — | 2026-10-27 |

### 8.2 替换清单

| 被取代物 | 类型 | 取代者 | 处置 | 保留理由 + 到期日 |
|---|---|---|---|---|
| `http.ts` 内联回调处理逻辑（403-445 行的实现，函数名保留） | 代码段 | `handleWebhookBotCallback`（services） | http.ts 改为薄壳调用 | — |

### 8.3 数据迁移 / 灰度

无持久数据迁移。开关文件不存在即功能关闭，天然灰度。

## 9.（不含 AI 推理，跳过）

## 10.（无状态机——ingress 无持久状态流转，跳过）

## 11. 完成定义（Definition of Done）

| 编号 | 验收项 | 满足 |
|---|---|---|
| AC-001 | §0 阅读导引齐全 | — |
| AC-002 | 契约测试：真实监听随机端口，覆盖 health 形状、Host 头 403、413、404/405、透传 200/400/401/503、无 Host 503、开关文件缺失/关闭/损坏不监听、端口占用不崩 | FR-001~FR-007 |
| AC-003 | 契约测试在上游 `IBotsService.handleProviderCallbackResponse` 签名变化时编译失败（mock 以 `Pick<IBotsService,"handleProviderCallbackResponse">` 类型绑定） | FR-004/FR-008 |
| AC-004 | Web 服务回归：`packages/server/test/botsHttp.test.ts` 既有用例全绿 + 补 `/api/bots/webhook/:botId` 用例 | FR-008 |
| AC-005 | services 公共函数单测：provider 校验、body 解析 fallback、状态映射、503 缺服务 | FR-008 |
| AC-006 | UI：webhook 出现在新建列表（类型层面/渲染测试或最小组件断言）；secret 走 `webhookSecretValue` 保存 | FR-009/FR-010 |
| AC-007 | i18n zh-CN/en-US 同 key 成对新增 | FR-011 |
| AC-008 | `docs/bot-webhook-ingress.md`（英文）+ `docs/bots.md` 指针；只写产品与技术事实 | FR-012 |
| AC-009 | `pnpm typecheck`、`pnpm lint`、相关包单测、`pnpm architecture:check --changed` 真跑并如实记录 | — |
| AC-010 | 新代码集中新文件：现有文件只加最小注册行（main/index.ts、host/index.ts、channels.ts、validation.ts、http.ts、BotsDialog.tsx、ProviderSettingsCard.tsx、index.ts(services)、i18n 两文件——均为小改） | FR-008~FR-011 |
| AC-011 | 兼容取舍已由任务书拍板（§8.1）；无未拍板的既有行为变更 | — |

**覆盖自查**：FR-001→AC-002；FR-002→AC-002；FR-003→AC-002；FR-004→AC-002/AC-003；FR-005→AC-002；FR-006→AC-002；FR-007→AC-002；FR-008→AC-003/AC-004/AC-005；FR-009→AC-006；FR-010→AC-006；FR-011→AC-007；FR-012→AC-008。

## 12. 待澄清点

（无阻塞项。已核对的事实：）
- `saveBot` 不清除 `webhookSecretRef`（`botsService.ts:8186-8190` 只在 `webhookSecretValue` 非空时写）；清除走既有 `removeBotSecret(botId)`（`botsService.ts:8229-8269`，同时清 credentialRef/webhookSecretRef/绑定身份并删凭据存储）。UI 的「移除 secret」复用 BotsDialog 既有 `onRemoveSecret` 路径。
- Host 选择取「任一存活」而非「主窗口」：与 cron 派发先例（`resolveCronDispatchHost`）一致；主窗口 Host 在窗口关闭时消失，任一存活更稳。属内部决策，不需拍板。

## 13. 过稿记录（MUST）

- 2026-10-27 ｜ 拍板人显式跳过本次 ｜ 任务书原文：「用户本人已明确声明本次跳过 spec 过稿门，spec 写完直接实现」。

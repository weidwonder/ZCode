# 业务域卡 — ZCode › bots-webhook-callback

## 职责
Webhook Bot 入站回调从 HTTP 进来到 bots 服务处理完成的链路：字段解析、secret 校验、状态码产生与透传。

## 权威实现与对外接口

| 能力 / 入口 | 权威实现（cite） | 类型（HTTP/RPC/cron/MQ/内部） | 版本 / 状态 | 调用方 / 触发源 | 约束（鉴权 / 幂等 / 顺序 / 取值范围） |
|---|---|---|---|---|---|
| 入站字段解析（botId/userId/text/attachments/elicitation） | `packages/services/src/bots/providers/webhookProvider.ts#parseCallback` | 内部 | canonical | processProviderCallback | botId 与 userId 缺一即弃；messageId 幂等键 |
| 回调处理与 secret 校验、status 产生 | `packages/services/src/bots/botsService.ts#processProviderCallback` | 内部 | canonical | IBotsService.handleProviderCallbackResponse | webhook secret 不匹配是业务层拒绝（200+invalid reply），不是 401；401 仅 feishu/lark 路径与 prepare 失败 |
| Web 服务 HTTP 路由 | `packages/server/src/http.ts#handleBotCallback` | HTTP | canonical | Web 部署 | 路径 /api/bots/:provider(/:botId)；非 webhook provider 400；body 解析/状态映射内联在此（曾抽到 services 共享函数供桌面端点复用，v1 方案回退后恢复原样，见 docs/decisions/2026-10-28-webhook-bot-ingress-to-local-task-api.md） |
| webhook secret 保存 | `packages/services/src/bots/botsService.ts#saveBot` | RPC | canonical | BotsDialog | secret 走参数 webhookSecretValue 存 CredentialService，配置文件只落 webhookSecretRef；saveBot 不清除 ref |
| secret 清除 | `packages/services/src/bots/botsService.ts#removeBotSecret` | RPC | canonical | BotsDialog | 同时清 credentialRef+webhookSecretRef+绑定身份并删凭据存储 |

## 陷阱项

- `credentialValue` — webhook 的入站鉴权 secret 不走它（它存 credentialRef，入站校验读的是 webhookSecretRef），保存 webhook secret 必须用 `saveBot` 的 `webhookSecretValue` 参数

## 测试入口

- `packages/server/test/botsHttp.test.ts`（Web 路由回归，mock ServiceCollection）
- `packages/services/src/bots/webhookCallbackHttp.test.ts`（公共函数单测，本分支新增）
- `packages/desktop/test/botWebhookIngress.test.ts`（桌面契约测试，本分支新增）

## 确认
2026-10-27｜来源：packages/services/src/bots/{botsService.ts,bots.ts,providers/webhookProvider.ts}、packages/server/src/http.ts

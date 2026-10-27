# Changelog

## 未发布

### 不兼容

### 新增

- 桌面版本机 Webhook Bot 入站端点：`<应用配置目录>/bot-webhook-ingress.json` 写 `{"enabled":true,"port":47821}` 后，桌面版在 `127.0.0.1:<port>` 提供 `GET /health` 与 `POST /api/bots/webhook(/:botId)`，语义与 Web 服务 `/api/bots/:provider` 路由一致（`docs/bot-webhook-ingress.md`）。
- Bots 设置的新建列表与 provider 设置卡开放 Webhook 类型：可填 webhookUrl 与入站密钥并保存。

### 变更

### 修复

### 内部

- Web 服务 `handleBotCallback` 的回调处理逻辑（provider 校验、body 解析、状态映射）收口到 `@zcode/services` 的 `handleWebhookBotCallback`，桌面入站端点共用同一实现，Web 行为不变（`packages/server/test/botsHttp.test.ts` 回归覆盖）。
- 新增 main↔host 消息对 `BotWebhookIngressDispatch` / `BotWebhookIngressResult`，Main 的入站请求经现有 requestId postMessage 通道转发给任一存活窗口 Host。
